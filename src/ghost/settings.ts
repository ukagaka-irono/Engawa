/** ベースウェアの設定。ブラウザの localStorage に保存する (使えない環境では保存しない)。 */
import { clone } from '../util/clone';
import type { CalEvent } from './ical';

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
  /** 利用者がドラッグで動かしたバルーンの位置 (スコープごと) */
  balloonOffsets?: Record<number, { x: number; y: number }>;
  /** 最後に起動した時刻 (ms) */
  lastBootAt?: number;
  /** 起動していた時間の合計 (秒。使用率のグラフ用) */
  totalSeconds?: number;
  /** \![set,property] でゴーストが書いた値 (プロパティ名 → 値) */
  properties?: Record<string, string>;
}

export interface Settings {
  /** 1文字あたりの表示ウェイト (ms) */
  talkWait: number;
  /** スクリプト終了からバルーンが消えるまで (ms) */
  balloonTimeout: number;
  /** 選択肢のタイムアウト (ms, 0 で無効) */
  choiceTimeout: number;
  scale: number;
  /** バルーンの拡大率 */
  balloonScale: number;
  userName: string;
  /** 喋った言葉を音声合成で読み上げる */
  speech: boolean;
  /** よそのページからの SSTP (postMessage) を受ける */
  acceptSstp: boolean;
  /** 音声認識で話しかける (OnVoiceRecognitionWord) */
  voiceRecognition?: boolean;
  /** ゴーストキャッシュ (切り替えたゴーストをしばらく取っておき、戻るときに速く起こす)。既定は使う */
  ghostCache?: boolean;
  running: string[];
  ghosts: Record<string, GhostState>;
  /** ゴースト用の予定表 (\![execute,schedule-add] など。すべてのゴーストで共有) */
  schedule?: CalEvent[];
  /** 最近使ったもの (パッケージのキー、新しい順) */
  history?: { ghost: string[]; balloon: string[] };
}

const KEY = 'engawa.settings';

const DEFAULTS: Settings = {
  talkWait: 50,
  balloonTimeout: 10_000,
  choiceTimeout: 30_000,
  scale: 1,
  balloonScale: 1,
  userName: 'ユーザ',
  speech: false,
  acceptSstp: true,
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

/** 最近使ったものに入れる (先頭が新しい。10件まで) */
export function addHistory(kind: 'ghost' | 'balloon', key: string): void {
  const h = (settings.history ??= { ghost: [], balloon: [] });
  h[kind] = [key, ...h[kind].filter((k) => k !== key)].slice(0, 10);
  saveSettings();
}

export function ghostState(key: string): GhostState {
  return (settings.ghosts[key] ??= {});
}
