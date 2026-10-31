/**
 * DLL 製 SHIORI を WebAssembly にしたもの (native/ でビルド) を動かす Web Worker。
 * ゴーストのファイルを Emscripten のメモリ上のファイルシステムに置き、DLL と同じ load / request / unload を呼ぶ。
 * やり取りはバイト列のまま (文字コードは NativeShiori が扱う)。書き換えられたファイルは flush / unload で知らせる。
 */
import { gunzipSync } from 'fflate';
import type { SaoriEffect, SaoriEnv } from '../saori/context';
import { SaoriHost } from '../saori/host';
import { saoriResolver } from '../saori/registry';
import { prepareWasmSaori, type WasmSaoriPlan } from '../saori/wasm';
import { callLoad, callRequest, ignoreCase, walk, writeFiles } from './native-call';
import { ENGINES, type EmscriptenModule, type EngineId } from './native-engines';

type ToNative =
  | { id: number; type: 'load'; engine: EngineId; wasm: Uint8Array; files: [string, Uint8Array][]; env: SaoriEnv; saori: WasmSaoriPlan[] }
  | { id: number; type: 'request'; data: Uint8Array }
  | { id: number; type: 'env'; env: SaoriEnv }
  | { id: number; type: 'flush' }
  | { id: number; type: 'put'; path: string; data: Uint8Array }
  | { id: number; type: 'unload' };

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToNative>) => void) | null;
};

/** ゴーストの ghost/master を置く場所 (load に渡すディレクトリ) */
const ROOT = '/ghost/master';

let mod: EmscriptenModule | undefined;
let saori: SaoriHost | undefined;
/** SAORI が読むブラウザの様子 (メインスレッドが送ってくる) */
let env: SaoriEnv;
/** 読み込んだときの中身。flush で比べて、変わったファイルだけ書き戻す */
const original = new Map<string, Uint8Array>();

const log = (message: string) => ctx.postMessage({ type: 'log', message });

/** SAORI がメインスレッドに頼むこと (クリップボード・音など)。答えは待たない */
function post(effect: SaoriEffect): void {
  const data = 'data' in effect ? effect.data : undefined;
  ctx.postMessage({ type: 'saori', effect }, data ? [data.buffer] : []);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** SHIORI が書いたファイル (セーブデータなど) をメインスレッドへ送る */
function flush(): void {
  if (!mod) return;
  for (const [path, abs] of walk(mod.FS, ROOT)) {
    const data = mod.FS.readFile(abs);
    const before = original.get(path);
    if (before && same(before, data)) continue;
    original.set(path, data);
    ctx.postMessage({ type: 'write', path, data });
  }
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
  ignoreCase(m.FS, ROOT);
  writeFiles(m.FS, ROOT, msg.files);
  for (const [path, data] of msg.files) original.set(path, data);
  m.FS.chdir(ROOT);
  mod = m;
  env = msg.env;
  // SHIORI が SAORI の DLL を開くと、native/shim/engawa_saori.c がここを呼ぶ
  const prepared = await prepareWasmSaori(msg.saori, msg.files, { fs: m.FS, root: ROOT, post, log });
  saori = new SaoriHost(m.FS, ROOT, saoriResolver({ fs: m.FS, env: () => env, post, log, prepared }), log);
  m.engawaSaori = saori.bridge;
  // DLL と同じく、ディレクトリは末尾に区切りを付けて渡す
  const dir = new TextEncoder().encode(`${ROOT}/`);
  if (!callLoad(m, dir)) log('SHIORI load() returned FALSE');
}

function request(data: Uint8Array): Uint8Array {
  if (!mod) throw new Error('SHIORI is not loaded');
  return callRequest(mod, data);
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
      case 'env':
        env = msg.env;
        break;
      case 'flush':
        flush();
        break;
      case 'put':
        // Engawa がゴーストのフォルダに書いたもの。書き戻さないように original にも入れる
        if (mod) writeFiles(mod.FS, ROOT, [[msg.path, msg.data]]);
        original.set(msg.path, msg.data);
        break;
      case 'unload':
        mod?._unload();
        // SHIORI が閉じ忘れた SAORI も unload する
        saori?.unloadAll();
        flush();
        mod = undefined;
        saori = undefined;
        break;
    }
    ctx.postMessage({ id: msg.id, type: 'result', ok: true, value }, value ? [value.buffer] : []);
  } catch (err) {
    ctx.postMessage({ id: msg.id, type: 'result', ok: false, error: describeError(err) });
  }
};

/** Emscripten は Error でないもの (exit() の ExitStatus など) も投げるので、読める形にする */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown };
    if (typeof message === 'string') return typeof name === 'string' ? `${name}: ${message}` : message;
    try {
      return JSON.stringify(err);
    } catch {
      // 循環しているなど
    }
  }
  return String(err);
}
