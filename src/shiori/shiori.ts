import type { SaoriEffect } from '../saori/context';
import type { Descript } from '../package/descript';
import type { FileTree } from '../vfs/files';
import { JsShiori } from './js-shiori';
import { detectNativeEngine } from './native-detect';
import { NativeShiori } from './native-shiori';
import { UnsupportedShiori } from './unsupported-shiori';

export interface ShioriHooks {
  /** SHIORI がファイルを書き込んだ (セーブデータ)。パスはゴーストルートからの相対。 */
  onWrite(path: string, data: Uint8Array): void;
  onLog(message: string): void;
  /** SAORI に頼まれたこと (クリップボード・音など。src/saori/context.ts) */
  onSaori?(effect: SaoriEffect): void;
  /** SHIORI がベースウェアに SSTP を送った (Node.js のプログラムの SSTP over HTTP)。応答を返す */
  onSstp?(request: string): Promise<string>;
}

/** SHIORI/3.0 の生のリクエスト文字列を受け取って生のレスポンス文字列を返すもの。 */
export interface Shiori {
  readonly name: string;
  load(): Promise<void>;
  request(text: string): Promise<string>;
  unload(): Promise<void>;
  /** Engawa がゴーストのフォルダに書いたファイル (HTTP の --file など。パスはゴーストルートから) を、SHIORI からも読めるようにする */
  putFile?(path: string, data: Uint8Array): void;
  /** SHIORI が書いたファイルを、いまメインスレッドに書き戻す (書いたらすぐ届くものは持たない) */
  flush?(): Promise<void>;
}

/**
 * ゴーストの descript.txt の `shiori` 指定から SHIORI を作る。
 * JavaScript モジュール (.js / .mjs) はそのまま、DLL は WebAssembly にした版 (native/) があればそれで動かす。
 */
export function createShiori(files: FileTree, descript: Descript, hooks: ShioriHooks): Shiori {
  const name = descript.str('shiori', 'shiori.dll');
  if (/\.m?js$/i.test(name) && files.has(`ghost/master/${name}`)) {
    return new JsShiori(files, name, hooks);
  }
  // SHIOLINK で Node.js のプログラムを動かすもの (DLL と同じ名前の .ini の commandline が node …)
  const argv = shiolinkNodeArgv(files, name);
  if (argv) return new JsShiori(files, name, hooks, { argv });
  const engine = detectNativeEngine(name, files);
  if (engine) return new NativeShiori(files, name, engine, hooks);
  return new UnsupportedShiori(name);
}

/** SHIOLINK.ini の commandline が「node[.exe] スクリプト 引数…」なら、スクリプトと引数 */
function shiolinkNodeArgv(files: FileTree, dll: string): string[] | undefined {
  if (!/^shiolink\.dll$/i.test(dll.replace(/^.*[\\/]/, ''))) return undefined;
  const ini = files.text(`ghost/master/${dll.replace(/\.dll$/i, '.ini')}`);
  const line = ini && /^\s*commandline\s*=\s*(.+?)\s*$/im.exec(ini)?.[1];
  if (!line) return undefined;
  const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return /(^|[\\/])node(\.exe)?$/i.test(words[0] ?? '') && words[1] ? words.slice(1) : undefined;
}
