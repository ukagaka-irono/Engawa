import type { Descript } from '../package/descript';
import type { FileTree } from '../vfs/files';
import { JsShiori } from './js-shiori';
import { UnsupportedShiori } from './unsupported-shiori';

export interface ShioriHooks {
  /** SHIORI がファイルを書き込んだ (セーブデータ)。パスはゴーストルートからの相対。 */
  onWrite(path: string, data: Uint8Array): void;
  onLog(message: string): void;
}

/** SHIORI/3.0 の生のリクエスト文字列を受け取って生のレスポンス文字列を返すもの。 */
export interface Shiori {
  readonly name: string;
  load(): Promise<void>;
  request(text: string): Promise<string>;
  unload(): Promise<void>;
}

/**
 * ゴーストの descript.txt の `shiori` 指定から SHIORI を作る。
 * ブラウザでは DLL を読めないため、JavaScript モジュール (.js / .mjs) のみ実行できる。
 */
export function createShiori(files: FileTree, descript: Descript, hooks: ShioriHooks): Shiori {
  const name = descript.str('shiori', 'shiori.dll');
  if (/\.m?js$/i.test(name) && files.has(`ghost/master/${name}`)) {
    return new JsShiori(files, name, hooks);
  }
  return new UnsupportedShiori(name);
}
