import { gunzipSync } from 'fflate';
import type { SaoriEffect, SaoriEnv } from '../src/saori/context';
import { SaoriHost } from '../src/saori/host';
import type { WasmSaoriKind } from '../src/saori/detect';
import { saoriResolver } from '../src/saori/registry';
import { prepareWasmSaori } from '../src/saori/wasm';
import createYaya from '../src/assets/shiori/yaya.mjs';
import YAYA_WASM from '../src/assets/shiori/yaya.wasm.gz?inline';
import type { EmscriptenModule, EngineFactory } from '../src/shiori/native-engines';
import { ignoreCase } from '../src/shiori/native-call';
import { internalSaori } from '../src/saori/internal';
import { normalizePath } from '../src/vfs/files';
import { encodeCharset } from '../src/util/charset-encode';

/** テストでの、ブラウザとページの様子 */
export const TEST_ENV: SaoriEnv = {
  screenWidth: 1920,
  screenHeight: 1080,
  availWidth: 1920,
  availHeight: 1040,
  devicePixelRatio: 1,
  language: 'ja',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  title: 'Engawa',
  windowLeft: 0,
  windowTop: 0,
  windowWidth: 1280,
  windowHeight: 720,
};

/**
 * WebAssembly にした SHIORI (native/build.mjs が作ったもの) を、Worker の代わりに Node でそのまま動かす。
 * native-worker.ts と同じく、ゴーストのファイルをメモリ上のファイルシステムに置いて load / request / unload を呼ぶ。
 */
/** data: URL (vite の ?inline) の中身 */
export const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));

/** saori は WebAssembly にした SAORI ({ DLL の ghost/master からのパス: [種類, 本体の data: URL] }) */
export async function boot(create: EngineFactory, wasmDataUrl: string, files: Record<string, Uint8Array>, saori: Record<string, [WasmSaoriKind, string]> = {}) {
  const wasmBinary = gunzipSync(dataUrlBytes(wasmDataUrl));
  const out: string[] = [];
  const m: EmscriptenModule = await create({ wasmBinary, locateFile: (p) => p, print: (s) => out.push(s), printErr: (s) => out.push(s) });
  const fs = m.FS as EmscriptenModule['FS'] & { mkdirTree(path: string): void };
  ignoreCase(m.FS, '/ghost/master');
  fs.mkdirTree('/ghost/master');
  for (const [path, data] of Object.entries(files)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir) fs.mkdirTree(`/ghost/master/${dir}`);
    fs.writeFile(`/ghost/master/${path}`, data);
  }
  fs.chdir('/ghost/master');
  // SAORI は src/saori のもの (Worker と同じ)。メインスレッドに頼むこと (クリップボードなど) は effects にためる
  const effects: SaoriEffect[] = [];
  const log = (s: string) => out.push(s);
  const post = (e: SaoriEffect) => effects.push(e);
  const plans = Object.entries(saori).map(([path, [kind, url]]) => ({ path: normalizePath(path), kind, wasm: dataUrlBytes(url) }));
  const prepared = await prepareWasmSaori(plans, Object.entries(files).map(([p, d]) => [normalizePath(p), d] as [string, Uint8Array]), { fs: m.FS, root: '/ghost/master', post, log });
  const host = new SaoriHost(m.FS, '/ghost/master', saoriResolver({ fs: m.FS, env: () => TEST_ENV, post, log, prepared }), log);
  m.engawaSaori = { ...host.bridge, directSstp: (req) => internalSaori(req, { fs: m.FS, root: '/ghost/master', post }) ?? null };
  const put = (bytes: Uint8Array) => {
    const p = m._malloc(bytes.length + 1);
    m.HEAPU8.set(bytes, p);
    m.HEAPU8[p + bytes.length] = 0;
    return p;
  };
  const dir = new TextEncoder().encode('/ghost/master/');
  const loaded = m._load(put(dir), dir.length);
  const raw = (bytes: Uint8Array): Uint8Array | undefined => {
    const lenPtr = m._malloc(4);
    m.HEAP32[lenPtr >> 2] = bytes.length;
    const res = m._request(put(bytes), lenPtr);
    const value = res ? m.HEAPU8.slice(res, res + m.HEAP32[lenPtr >> 2]) : undefined;
    if (res) m._free(res);
    m._free(lenPtr);
    return value;
  };
  /** SHIORI/3.0 の GET を送り、応答を charset で読む */
  const get = (id: string, charset = 'Shift_JIS', refs: string[] = []) => {
    const text = [`GET SHIORI/3.0`, `Charset: ${charset}`, 'Sender: Engawa', 'SecurityLevel: local', `ID: ${id}`, ...refs.map((r, i) => `Reference${i}: ${r}`)].join('\r\n');
    const res = raw(encodeCharset(text + '\r\n\r\n', charset));
    return res && new TextDecoder(charset).decode(res);
  };
  return { m, loaded, raw, get, out, effects, saori: host, read: (path: string) => m.FS.readFile(`/ghost/master/${path}`) };
}


/**
 * SAORI を1つ開く。SHIORI (YAYA) の Worker と同じ置き場 (SaoriHost) から、SHIORI が DLL を呼ぶのと同じ口
 * (bridge の open・load・request) で呼ぶ。wasm を渡せば WebAssembly の SAORI、無ければ DLL の名前で JavaScript のもの
 */
export async function openSaori(dllPath: string, files: Record<string, Uint8Array> = {}, wasm?: [WasmSaoriKind, string]) {
  const y = await boot(createYaya, YAYA_WASM, { [dllPath]: new Uint8Array(8), ...files }, wasm ? { [dllPath]: wasm } : {});
  const bridge = y.saori.bridge;
  const id = bridge.open(new TextEncoder().encode(`/ghost/master/${dllPath}`));
  if (id <= 0) throw new Error(`SAORI ${dllPath} を開けません: ${y.out.join('\n')}`);
  if (bridge.load(id, new TextEncoder().encode(`/ghost/master/${dllPath.slice(0, dllPath.lastIndexOf('/') + 1)}`)) !== 1) throw new Error(`SAORI ${dllPath} の load に失敗`);
  /** EXECUTE を Shift_JIS で送り、応答の Result と Value (ValueN の番号の順) を読む */
  const execute = (...args: string[]) => {
    const req = ['EXECUTE SAORI/1.0', 'Charset: Shift_JIS', 'Sender: Engawa', ...args.map((a, i) => `Argument${i}: ${a}`), '', ''].join('\r\n');
    const res = new TextDecoder('shift_jis').decode(bridge.request(id, encodeCharset(req, 'Shift_JIS')) ?? new Uint8Array(0));
    return {
      status: Number(/^SAORI\/1\.0 (\d+)/.exec(res)?.[1]),
      result: /^Result: (.*)\r$/m.exec(res)?.[1],
      values: [...res.matchAll(/^Value(\d+): (.*)\r$/gm)].sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]),
      raw: res,
    };
  };
  return { y, execute, unload: () => bridge.unload(id) };
}
