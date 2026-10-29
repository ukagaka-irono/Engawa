/**
 * DLL 製 SHIORI を WebAssembly にしたもの (native/ でビルド) を動かす Web Worker。
 * ゴーストのファイルを Emscripten のメモリ上のファイルシステムに置き、DLL と同じ load / request / unload を呼ぶ。
 * やり取りはバイト列のまま (文字コードは NativeShiori が扱う)。書き換えられたファイルは flush / unload で知らせる。
 */
import { gunzipSync } from 'fflate';
import { ENGINES, type EmscriptenModule, type EngineId } from './native-engines';

type ToNative =
  | { id: number; type: 'load'; engine: EngineId; wasm: Uint8Array; files: [string, Uint8Array][] }
  | { id: number; type: 'request'; data: Uint8Array }
  | { id: number; type: 'flush' }
  | { id: number; type: 'unload' };

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToNative>) => void) | null;
};

/** ゴーストの ghost/master を置く場所 (load に渡すディレクトリ) */
const ROOT = '/ghost/master';

let mod: EmscriptenModule | undefined;
/** 読み込んだときの中身。flush で比べて、変わったファイルだけ書き戻す */
const original = new Map<string, Uint8Array>();

const log = (message: string) => ctx.postMessage({ type: 'log', message });

function mkdirs(fs: EmscriptenModule['FS'], dir: string): void {
  let path = '';
  for (const part of dir.split('/').filter(Boolean)) {
    path += '/' + part;
    if (!fs.analyzePath(path).exists) fs.mkdir(path);
  }
}

/** ROOT 以下のファイルを (ROOT からの相対パス, 中身) で列挙する */
function* walk(fs: EmscriptenModule['FS'], dir: string, rel = ''): Generator<[string, Uint8Array]> {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    const relPath = rel ? `${rel}/${name}` : name;
    const st = fs.stat(path);
    if (fs.isDir(st.mode)) yield* walk(fs, path, relPath);
    else if (fs.isFile(st.mode)) yield [relPath, fs.readFile(path)];
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** SHIORI が書いたファイル (セーブデータなど) をメインスレッドへ送る */
function flush(): void {
  if (!mod) return;
  for (const [path, data] of walk(mod.FS, ROOT)) {
    const before = original.get(path);
    if (before && same(before, data)) continue;
    original.set(path, data);
    ctx.postMessage({ type: 'write', path, data });
  }
}

/** バイト列を SHIORI のメモリに置く (DLL の GlobalAlloc に当たる。解放は SHIORI 側の GlobalFree = free) */
function put(m: EmscriptenModule, data: Uint8Array): number {
  const ptr = m._malloc(data.length + 1);
  m.HEAPU8.set(data, ptr);
  m.HEAPU8[ptr + data.length] = 0;
  return ptr;
}

async function load(msg: Extract<ToNative, { type: 'load' }>): Promise<void> {
  const engine = ENGINES[msg.engine];
  if (!engine) throw new Error(`unknown SHIORI engine: ${msg.engine}`);
  const m = await engine({
    wasmBinary: gunzipSync(msg.wasm),
    locateFile: (path) => path,
    print: (s: string) => log(s),
    printErr: (s: string) => log(s),
  });
  mkdirs(m.FS, ROOT);
  for (const [path, data] of msg.files) {
    const slash = path.lastIndexOf('/');
    if (slash >= 0) mkdirs(m.FS, `${ROOT}/${path.slice(0, slash)}`);
    m.FS.writeFile(`${ROOT}/${path}`, data);
    original.set(path, data);
  }
  m.FS.chdir(ROOT);
  mod = m;
  // DLL と同じく、ディレクトリは末尾に区切りを付けて渡す
  const dir = new TextEncoder().encode(`${ROOT}/`);
  if (!m._load(put(m, dir), dir.length)) log('SHIORI load() returned FALSE');
}

function request(data: Uint8Array): Uint8Array {
  const m = mod;
  if (!m) throw new Error('SHIORI is not loaded');
  const lenPtr = m._malloc(4);
  try {
    m.HEAP32[lenPtr >> 2] = data.length;
    const res = m._request(put(m, data), lenPtr);
    if (!res) return new Uint8Array(0);
    const len = m.HEAP32[lenPtr >> 2];
    const out = m.HEAPU8.slice(res, res + len);
    m._free(res);
    return out;
  } finally {
    m._free(lenPtr);
  }
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    let value: Uint8Array | undefined;
    switch (msg.type) {
      case 'load':
        await load(msg);
        break;
      case 'request':
        value = request(msg.data);
        break;
      case 'flush':
        flush();
        break;
      case 'unload':
        mod?._unload();
        flush();
        mod = undefined;
        break;
    }
    ctx.postMessage({ id: msg.id, type: 'result', ok: true, value }, value ? [value.buffer] : []);
  } catch (err) {
    ctx.postMessage({ id: msg.id, type: 'result', ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
