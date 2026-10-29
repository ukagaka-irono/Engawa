import type { EmscriptenFS } from '../shiori/native-engines';

/**
 * SAORI が Worker の外 (メインスレッド) に頼むこと。Worker からは触れないもの (クリップボード・音など) は
 * NativeShiori を通して Ghost に渡す。
 */
export type SaoriEffect =
  | { kind: 'clipboard'; text: string }
  /** path はパッケージのルートからの相対 (ghost/master/…)。data はファイルの中身 (SHIORI のファイルシステムにあれば) */
  | { kind: 'sound'; path: string; data?: Uint8Array }
  /** SAORI がファイルを書いた (画像を作ったなど)。すぐに表示に使えるよう、セーブデータと同じく書き戻す */
  | { kind: 'write'; path: string; data: Uint8Array };

/** SAORI が知りたい、ブラウザとページの様子。メインスレッドが読み込みのとき (と変わったとき) に送る */
export interface SaoriEnv {
  screenWidth: number;
  screenHeight: number;
  /** タスクバーなどを除いた広さ */
  availWidth: number;
  availHeight: number;
  devicePixelRatio: number;
  language: string;
  userAgent: string;
  hardwareConcurrency: number;
  /** おおよそのメモリ (GB)。分からなければ 0 */
  deviceMemory: number;
  /** ページ (Engawa の窓) の題名・位置・大きさ */
  title: string;
  windowLeft: number;
  windowTop: number;
  windowWidth: number;
  windowHeight: number;
}

/** JavaScript で作り直した SAORI に渡すもの */
export interface SaoriContext {
  /** SHIORI のメモリ上のファイルシステム (ゴーストのファイル) */
  fs: EmscriptenFS;
  /** DLL のパス (/ghost/master/…) */
  path: string;
  /** DLL のあるディレクトリ (末尾に /) */
  dir: string;
  env(): SaoriEnv;
  post(effect: SaoriEffect): void;
  log(message: string): void;
}

/** メインスレッドで、いまの様子を読む */
export function readSaoriEnv(): SaoriEnv {
  return {
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    language: navigator.language,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0,
    title: document.title,
    windowLeft: window.screenX,
    windowTop: window.screenY,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  };
}
