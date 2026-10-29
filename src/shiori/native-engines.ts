/**
 * WebAssembly にした SHIORI の読み込み口 (Worker 側)。native/build.mjs が src/assets/shiori/ に作る。
 * 本体の wasm は大きいので、ここではなくメインスレッド (native-detect.ts) が data: URL で持ち、load のときに渡す。
 */
import createAya5 from '../assets/shiori/aya5.mjs';
import createKagari from '../assets/shiori/kagari.mjs';
import createKawari from '../assets/shiori/kawari.mjs';
import createKawari7 from '../assets/shiori/kawari7.mjs';
import createMinato from '../assets/shiori/minato.mjs';
import createNashi from '../assets/shiori/nashi.mjs';
import createQuickshiori from '../assets/shiori/quickshiori.mjs';
import createSatori from '../assets/shiori/satori.mjs';
import createYaya from '../assets/shiori/yaya.mjs';

export type EngineId = 'yaya' | 'aya5' | 'satori' | 'kawari' | 'kawari7' | 'nashi' | 'minato' | 'kagari' | 'quickshiori';

/** Emscripten のメモリ上のファイルシステム (使うものだけ) */
export interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  analyzePath(path: string): { exists: boolean };
  chdir(path: string): void;
}

/** SHIORI の DLL と同じ load / request / unload と、メモリの確保・解放 */
export interface EmscriptenModule {
  FS: EmscriptenFS;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _load(ptr: number, len: number): number;
  _request(ptr: number, lenPtr: number): number;
  _unload(): number;
}

export interface EngineOptions {
  wasmBinary: Uint8Array;
  locateFile(path: string): string;
  print(text: string): void;
  printErr(text: string): void;
}

export type EngineFactory = (options: EngineOptions) => Promise<EmscriptenModule>;

export const ENGINES: Record<EngineId, EngineFactory> = {
  yaya: createYaya,
  aya5: createAya5,
  satori: createSatori,
  kawari: createKawari,
  kawari7: createKawari7,
  nashi: createNashi,
  minato: createMinato,
  kagari: createKagari,
  quickshiori: createQuickshiori,
};
