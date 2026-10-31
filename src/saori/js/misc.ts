import type { SaoriContext } from '../context';
import { findFile, normalizePath, type JsSaori } from '../host';

/** nullsaori.dll (CSaori)。何もせず 200 OK を返す */
export function nullSaori(): JsSaori {
  return { execute: () => ({ status: 200 }) };
}

/** SaoriTest.dll (CSaori の試し)。DLL のディレクトリと Argument0・Argument1 をつないで返す */
export function saoriTest(ctx: SaoriContext): JsSaori {
  return { execute: ({ args }) => ({ result: `${ctx.dir.replace(/\//g, '\\')}${args[0] ?? ''}${args[1] ?? ''}` }) };
}

/** example (ninix-saori の見本)。Value0 に Argument0 を返す */
export function ninixExample(): JsSaori {
  return { execute: ({ args }) => ({ result: 'This is example.', values: [args[0] ?? ''] }) };
}

/** saori_call_translator (ninix-saori)。外の翻訳プログラムを呼ぶものなので、ブラウザでは翻訳できないと答える */
export function callTranslator(): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'call') return { result: 'translator is not available in the browser' };
      if (cmd === 'result') return { result: '-1' };
      return { status: 400 };
    },
  };
}

// ---------------------------------------------------------------- FileVersion

/** PE ファイルのバージョン情報 (VS_VERSIONINFO) を読む。無ければ undefined */
export function readVersionInfo(data: Uint8Array): { version: string; strings: Map<string, string> } | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return undefined;
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > data.length || dv.getUint32(pe, true) !== 0x4550) return undefined;
  const sections = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  const magic = dv.getUint16(opt, true);
  const dirBase = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = dv.getUint32(dirBase + 2 * 8, true);
  if (!rsrcRva) return undefined;
  // RVA をファイルの位置に
  const sec = opt + optSize;
  const toOffset = (rva: number) => {
    for (let i = 0; i < sections; i++) {
      const h = sec + i * 40;
      const va = dv.getUint32(h + 12, true);
      const size = Math.max(dv.getUint32(h + 8, true), dv.getUint32(h + 16, true));
      if (rva >= va && rva < va + size) return rva - va + dv.getUint32(h + 20, true);
    }
    return -1;
  };
  const root = toOffset(rsrcRva);
  if (root < 0) return undefined;
  /** リソースの木を type → name → language の順にたどる (最初のものを使う) */
  const entry = (dir: number, id?: number): number | undefined => {
    const named = dv.getUint16(dir + 12, true);
    const ids = dv.getUint16(dir + 14, true);
    for (let i = 0; i < named + ids; i++) {
      const e = dir + 16 + i * 8;
      const name = dv.getUint32(e, true);
      if (id !== undefined && name !== id) continue;
      return dv.getUint32(e + 4, true);
    }
    return undefined;
  };
  let node = entry(root, 16); // RT_VERSION
  for (let depth = 0; depth < 2 && node !== undefined && node & 0x80000000; depth++) node = entry(root + (node & 0x7fffffff));
  if (node === undefined || node & 0x80000000) return undefined;
  const leaf = root + node;
  const at = toOffset(dv.getUint32(leaf, true));
  const len = dv.getUint32(leaf + 4, true);
  if (at < 0 || at + len > data.length) return undefined;
  const block = data.subarray(at, at + len);
  const bv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const utf16 = (p: number) => {
    let end = p;
    while (end + 1 < block.length && bv.getUint16(end, true)) end += 2;
    return { text: new TextDecoder('utf-16le').decode(block.subarray(p, end)), next: end + 2 };
  };
  const align = (p: number) => (p + 3) & ~3;
  // VS_VERSIONINFO: wLength, wValueLength, wType, szKey, padding, VS_FIXEDFILEINFO
  const key = utf16(6);
  const fixed = align(key.next);
  if (bv.getUint32(fixed, true) !== 0xfeef04bd) return undefined;
  const ms = bv.getUint32(fixed + 8, true);
  const ls = bv.getUint32(fixed + 12, true);
  const version = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  const strings = new Map<string, string>();
  // StringFileInfo → StringTable → String (最初の言語のもの)
  const walk = (p: number, end: number, depth: number) => {
    while (p + 6 < end) {
      const len2 = bv.getUint16(p, true);
      if (!len2) break;
      const valueLen = bv.getUint16(p + 2, true);
      const type = bv.getUint16(p + 4, true);
      const k = utf16(p + 6);
      const value = align(k.next);
      if (depth === 2 && type === 1) {
        if (!strings.has(k.text)) strings.set(k.text, utf16(value).text.slice(0, Math.max(0, valueLen - 1)));
      } else if (depth < 2 && (depth > 0 || k.text === 'StringFileInfo')) {
        walk(value, p + len2, depth + 1);
      }
      p = align(p + len2);
    }
  };
  walk(align(fixed + bv.getUint16(2, true)), block.length, 0);
  return { version, strings };
}

/**
 * FileVersion.dll (CSaori)。ゴーストの中のファイルのバージョン情報。
 *   Result: 1.2.3.4 (無ければ ERROR_OPEN / ERROR_NORESOURCE)。Value0…4: 製品名・説明・コメント・著作権・商標
 */
export function fileVersion(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const target = args[0];
      if (!target) return { status: 400 };
      const path = findFile(ctx.fs, normalizePath(target, ctx.dir));
      if (!path) return { result: 'ERROR_OPEN' };
      const info = readVersionInfo(ctx.fs.readFile(path));
      if (!info) return { result: 'ERROR_NORESOURCE' };
      const s = info.strings;
      return { result: info.version, values: ['ProductName', 'FileDescription', 'Comments', 'LegalCopyright', 'LegalTrademarks'].map((k) => s.get(k) ?? '') };
    },
  };
}

// ---------------------------------------------------------------- MakotoUtil

/**
 * MakotoUtil.dll (CSaori)。SAORI は同期で答えるので、入力ボックス・メッセージボックスを出して待つことができない。
 *   keydown       押されていないとして 0
 *   inputbox      取り消したときと同じく、初期値を返す
 *   messagebox    OK (1) を押したとして返す。文はブラウザのコンソールに出す
 */
export function makotoUtil(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'keydown') return { result: '0' };
      if (cmd === 'inputbox') return { result: (args[3] ?? '').replace(/\r\n/g, '\x02') };
      if (cmd === 'messagebox') {
        ctx.log(`MakotoUtil: ${args[2] ?? ''} ${args[1] ?? ''}`);
        return { result: '1' };
      }
      return { status: 400 };
    },
  };
}

// ---------------------------------------------------------------- AquesTalk

/**
 * AqTalkSaori.dll (CSaori、AquesTalk を呼ぶもの)。AquesTalk の代わりにブラウザの音声合成で読む (声は選べない)。
 *   PLAYSYNC / PLAYASYNC 文 [速さ]   読む (待たない)
 *   STOP                             止める
 *   CREATEWAV                        WAV は作れないのでエラー
 *   CHANGEVOICE                      受けるだけ
 */
export function aqTalk(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toUpperCase();
      if (cmd.includes('PLAYSYNC') || cmd.includes('PLAYASYNC')) {
        if (!args[1]) return { result: 'ERROR002：最低２つ以上の引数を指定してください' };
        ctx.post({ kind: 'speak', text: args[1], rate: Number(args[2]) ? Number(args[2]) / 100 : undefined });
        return { result: '' };
      }
      if (cmd.includes('STOP')) {
        ctx.post({ kind: 'speak', text: '', stop: true });
        return { result: '' };
      }
      if (cmd.includes('CREATEWAV')) return { result: 'ERROR100：Syntheのエラー(ブラウザでは WAV を作れません)' };
      if (cmd.includes('CHANGEVOICE')) return { result: '' };
      return { result: 'ERROR003：不正な命令です' };
    },
  };
}

// ---------------------------------------------------------------- ブラウザでは行えないもの

/**
 * Windows の機能そのものを使う SAORI (マウスを動かす・壁紙・スクリーンショット・ほかのアプリを動かすなど)。
 * ブラウザでは行えないので、それぞれの「できなかった」ときの答えを返す。ゴーストの台本は止まらない
 */
export function unavailable(name: string, answer: { status?: 200 | 204 | 400 | 500; result?: string }) {
  return (ctx: SaoriContext): JsSaori => ({
    execute({ args }) {
      ctx.log(`${name}: ブラウザでは行えません (${args.join(', ')})`);
      return answer;
    },
  });
}
