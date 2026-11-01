import { unzipSync } from 'fflate';
import { t } from '../i18n';
import { FileTree } from './files';

interface RawName {
  /** fflate が付けた名前 (UTF-8 フラグがあれば UTF-8、無ければ latin1 として読んだもの) */
  fflateKey: string;
  bytes: Uint8Array;
  utf8: boolean;
  /** Info-ZIP Unicode Path 拡張 (0x7075) に入っている UTF-8 の名前 */
  unicodePath?: string;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8 = new TextDecoder('utf-8');
const sjis = new TextDecoder('shift_jis');

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function isAscii(bytes: Uint8Array): boolean {
  return bytes.every((b) => b < 0x80);
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** セントラルディレクトリからファイル名の生バイトと UTF-8 フラグ (bit 11) を読む。ZIP64 などは null。 */
function readCentralNames(data: Uint8Array): RawName[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 22) return null;
  // EOCD を末尾から探す (コメントは最大 65535 バイト)
  let eocd = -1;
  for (let i = data.length - 22, min = Math.max(0, data.length - 22 - 0xffff); i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) return null;
  const out: RawName[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== 0x02014b50) return null;
    const flags = view.getUint16(p + 8, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const bytes = data.subarray(p + 46, p + 46 + nameLen);
    const isUtf8 = (flags & 0x800) !== 0;
    let unicodePath: string | undefined;
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end; ) {
      const id = view.getUint16(e, true);
      const size = view.getUint16(e + 2, true);
      // 0x7075: version(1) + 元の名前の CRC32(4) + UTF-8 の名前。
      // 名前だけ書き換えられて古い拡張が残っていることがあるので、CRC が今の名前と合うときだけ使う
      if (id === 0x7075 && size > 5 && data[e + 4] === 1 && view.getUint32(e + 5, true) === crc32(bytes)) {
        try {
          unicodePath = utf8Strict.decode(data.subarray(e + 9, e + 4 + size));
        } catch {
          // 壊れていたら使わない
        }
      }
      e += 4 + size;
    }
    out.push({ fflateKey: isUtf8 ? utf8.decode(bytes) : latin1(bytes), bytes, utf8: isUtf8, unicodePath });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** セントラルディレクトリが読めないときの推測 (エントリごとに UTF-8 か Shift_JIS か) */
function guessName(name: string): string {
  if (![...name].some((c) => c.charCodeAt(0) >= 0x80) || [...name].some((c) => c.charCodeAt(0) > 0xff)) return name;
  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0));
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return sjis.decode(bytes);
  }
}

/** 展開してよい大きさの合計 (ゴーストの .nar はふつう数十 MB まで) */
export const MAX_UNZIPPED = 512 * 1024 * 1024;

/**
 * .nar / .zip を展開する。
 * UTF-8 フラグのある名前はそのまま、無い名前はアーカイブ全体で UTF-8 として読めるなら UTF-8、
 * そうでなければ Shift_JIS として読む (伺かのアーカイブは Windows で作られたものが多い)。
 */
export function filesFromZip(data: Uint8Array): FileTree {
  // 展開した大きさの合計を先に見て、大きすぎるもの (圧縮爆弾) は展開しない
  let total = 0;
  const entries = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error(t('install.tooLarge', { size: Math.round(MAX_UNZIPPED / 1024 / 1024) }));
      return true;
    },
  });
  const raw = readCentralNames(data);
  const names = new Map<string, string>();
  if (raw) {
    const plain = raw.filter((r) => !r.utf8 && !r.unicodePath && !isAscii(r.bytes));
    const plainIsUtf8 = plain.every((r) => {
      try {
        utf8Strict.decode(r.bytes);
        return true;
      } catch {
        return false;
      }
    });
    for (const r of raw) {
      const name = r.unicodePath ?? (r.utf8 || isAscii(r.bytes) ? r.fflateKey : plainIsUtf8 ? utf8.decode(r.bytes) : sjis.decode(r.bytes));
      names.set(r.fflateKey, name);
    }
  }
  const tree = new FileTree();
  for (const [key, bytes] of Object.entries(entries)) {
    // Windows の道具で作ったものには、区切りが \ のフォルダ (ghost\master\) もある。
    // Shift_JIS の「ソ」などは2バイト目が \ なので、名前を読んでから見る
    const name = names.get(key) ?? guessName(key);
    if (/[/\\]$/.test(name)) continue;
    tree.set(name, bytes);
  }
  return tree;
}

/** `<input webkitdirectory>` で選ばれたファイル群。先頭のフォルダ名を返り値の name にする。 */
export async function filesFromFileList(files: File[]): Promise<{ name: string; tree: FileTree }> {
  const tree = new FileTree();
  let name = '';
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const slash = rel.indexOf('/');
    if (slash > 0) {
      name ||= rel.slice(0, slash);
      tree.set(rel.slice(slash + 1), new Uint8Array(await file.arrayBuffer()));
    } else {
      tree.set(rel, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return { name, tree };
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** ドラッグ&ドロップされたフォルダを再帰的に読む。 */
export async function filesFromDirectoryEntry(dir: FileSystemDirectoryEntry): Promise<FileTree> {
  const tree = new FileTree();
  const walk = async (d: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = d.createReader();
    // readEntries は一度に全件返さないことがあるので空になるまで呼ぶ
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const e of batch) {
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, prefix + e.name + '/');
        else {
          const file = await entryFile(e as FileSystemFileEntry);
          tree.set(prefix + e.name, new Uint8Array(await file.arrayBuffer()));
        }
      }
    }
  };
  await walk(dir, '');
  return tree;
}
