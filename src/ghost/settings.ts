/** ベースウェアの設定。ブラウザの localStorage に保存する (使えない環境では保存しない)。 */
import { clone } from '../util/clone';

export interface CharacterPosition {
  right: number;
  bottom: number;
}

export interface GhostState {
  shell?: string;
  balloon?: string;
  bootCount?: number;
  positions?: Record<number, CharacterPosition>;
  /** `${shell}:${scope}` → 有効な bindgroup ID */
  dressup?: Record<string, number[]>;
}

export interface Settings {
  /** 1文字あたりの表示ウェイト (ms) */
  talkWait: number;
  /** スクリプト終了からバルーンが消えるまで (ms) */
  balloonTimeout: number;
  /** 選択肢のタイムアウト (ms, 0 で無効) */
  choiceTimeout: number;
  scale: number;
  userName: string;
  running: string[];
  ghosts: Record<string, GhostState>;
}

const KEY = 'engawa.settings';

const DEFAULTS: Settings = {
  talkWait: 50,
  balloonTimeout: 10_000,
  choiceTimeout: 30_000,
  scale: 1,
  userName: 'ユーザ',
  running: [],
  ghosts: {},
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 保存領域が使えない (プライベートモード等)
  }
  return clone(DEFAULTS);
}

export const settings: Settings = load();

let timer: number | undefined;
let persistent = true;

/** 設定を保存しない (よそのページに埋め込んだときのおためし起動など)。既定の設定から始める */
export function useTemporarySettings(): void {
  persistent = false;
  clearTimeout(timer);
  Object.assign(settings, clone(DEFAULTS));
}

/** すぐに保存する。保存領域が使えなかったら false (設定はこのページを開いている間だけ有効) */
export function saveSettingsNow(): boolean {
  clearTimeout(timer);
  if (!persistent) return true;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** 変更をまとめて保存する (ゴーストの位置など、失敗しても知らせないもの) */
export function saveSettings(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => void saveSettingsNow(), 200);
}

export function ghostState(key: string): GhostState {
  return (settings.ghosts[key] ??= {});
}
