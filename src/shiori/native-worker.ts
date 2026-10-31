/**
 * DLL 製 SHIORI を WebAssembly にしたもの (native/ でビルド) を動かす Web Worker。
 * ゴーストのファイルを Emscripten のメモリ上のファイルシステムに置き、DLL と同じ load / request / unload を呼ぶ。
 * やり取りはバイト列のまま (文字コードは NativeShiori が扱う)。書き換えられたファイルは flush / unload で知らせる。
 */
import { gunzipSync } from 'fflate';
import type { SaoriEffect, SaoriEnv } from '../saori/context';
import { SaoriHost } from '../saori/host';
import { internalSaori } from '../saori/internal';
import { saoriResolver } from '../saori/registry';
import { prepareWasmSaori, type WasmSaoriPlan } from '../saori/wasm';
import { callLoad, callRequest, ignoreCase, mkdirs, walk, writeFiles } from './native-call';
import { ENGINES, type EmscriptenModule, type EngineId } from './native-engines';

type ToNative =
  | { id: number; type: 'load'; engine: EngineId; wasm: Uint8Array; files: [string, Uint8Array][]; env: SaoriEnv; saori: WasmSaoriPlan[]; shellDirs?: string[] }
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

/** ゴーストのシェルのフォルダ (パッケージの shell/)。SHIORI が ..\..\shell\master\… へ書けるようにする */
const SHELL_ROOT = '/shell';

/** SHIORI が書いたファイル (セーブデータ、シェルのフォルダへ書いたサーフェスの定義など) をメインスレッドへ送る */
function flush(): void {
  if (!mod) return;
  const shell = mod.FS.analyzePath(SHELL_ROOT).exists ? [...walk(mod.FS, SHELL_ROOT)].map(([rel, abs]) => [`../../shell/${rel}`, abs] as [string, string]) : [];
  for (const [path, abs] of [...walk(mod.FS, ROOT), ...shell]) {
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
  ignoreCase(m.FS, SHELL_ROOT);
  writeFiles(m.FS, ROOT, msg.files);
  // シェルのフォルダは空で作る (中身は読まないが、ゴーストがサーフェスの定義などを書き出すことがある)
  for (const d of msg.shellDirs ?? []) mkdirs(m.FS, `${SHELL_ROOT}/${d}`);
  for (const [path, data] of msg.files) original.set(path, data);
  m.FS.chdir(ROOT);
  mod = m;
  env = msg.env;
  // SHIORI が SAORI の DLL を開くと、native/shim/engawa_saori.c がここを呼ぶ
  const prepared = await prepareWasmSaori(msg.saori, msg.files, { fs: m.FS, root: ROOT, post, log });
  saori = new SaoriHost(m.FS, ROOT, saoriResolver({ fs: m.FS, env: () => env, post, log, prepared }), log);
  // Direct SSTP (SAORI over DirectSSTP) は、Engawa の内蔵モジュール (src/saori/internal.ts) が答える
  m.engawaSaori = {
    ...saori.bridge,
    // SAORI と同じく、中の例外を SHIORI (wasm) に投げ返さない
    directSstp: (req) => {
      try {
        return internalSaori(req, { fs: m.FS, root: ROOT, post }) ?? null;
      } catch (e) {
        log(`Direct SSTP: ${(e as Error).message}`);
        return null;
      }
    },
  };
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
        try {
          mod?._unload();
        } finally {
          // unload で失敗しても、SAORI を閉じてセーブデータを書き戻す
          try {
            // SHIORI が閉じ忘れた SAORI も unload する
            saori?.unloadAll();
          } finally {
            flush();
            mod = undefined;
            saori = undefined;
          }
        }
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
