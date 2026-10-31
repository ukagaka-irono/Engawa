import { holidayRefs } from '../util/holidays';
import type { Ghost } from './ghost';
import { settings } from './settings';

/**
 * ブラウザから分かる、ゴーストのまわりの変化をイベントにする (起動時は NOTIFY、変わったときは GET)。
 *   ネットワーク (OnNetworkStatusChange)・暗い表示 (OnDarkTheme)・バッテリー (OnBatteryNotify など)・画面の大きさ (OnDisplayChange)・
 *   ゲームパッド (OnGamepad…)・音声認識 (OnVoiceRecognitionWord)・全員の重なりと見切れ (OnOtherOverlap / OnOtherOffscreen)
 */

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
  dischargingTime: number;
  chargingTime: number;
}

/** Gamepad API の「標準」の並び (https://w3c.github.io/gamepad/#remapping) の名前 */
const BUTTONS: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  8: 'Back',
  9: 'Start',
  10: 'LSB',
  11: 'RSB',
  12: 'DPadUp',
  13: 'DPadDown',
  14: 'DPadLeft',
  15: 'DPadRight',
};
const DEADZONE = 0.15;
const AXIS_STEP = 0.1;

/** 確かめるフォントの候補 (OnNotifyFontInfo。ブラウザは入っているフォントを一覧できないので、よくあるものを測って調べる) */
const FONT_CANDIDATES = [
  'MS UI Gothic', 'MS Gothic', 'MS PGothic', 'MS Mincho', 'MS PMincho', 'Meiryo', 'Meiryo UI', 'Yu Gothic', 'Yu Gothic UI', 'Yu Mincho', 'BIZ UDGothic',
  'BIZ UDPGothic', 'BIZ UDMincho', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Hiragino Mincho ProN', 'Noto Sans JP', 'Noto Serif JP', 'Noto Sans CJK JP',
  'IPAGothic', 'IPAMincho', 'Arial', 'Times New Roman', 'Courier New', 'Segoe UI', 'Tahoma', 'Verdana', 'Georgia', 'Consolas', 'Helvetica', 'Menlo',
];

/** フォントが入っているか (既定の字体と幅が違えば入っている) */
function availableFonts(): string[] {
  if (typeof document === 'undefined') return [];
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return [];
  const sample = 'mmmmmmmmmmlli 永あア';
  const width = (font: string) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(sample).width;
  };
  const bases = ['monospace', 'serif', 'sans-serif'].map((b) => [b, width(b)] as const);
  return FONT_CANDIDATES.filter((f) => bases.some(([b, w]) => width(`"${f}", ${b}`) !== w));
}

const darkMedia = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined);

export class EnvironmentEvents {
  private battery?: BatteryLike;
  private lastBatteryFlags = '';
  private pads = new Map<number, { buttons: boolean[]; axes: number[] }>();
  private lastOverlap = '';
  private lastOffscreen = '';
  private resizeTimer?: number;
  private recognition?: { stop(): void; start(): void; abort(): void; onresult: unknown; onend: unknown; onerror: unknown; continuous: boolean; lang: string; interimResults: boolean };
  private listening = false;

  constructor(
    private readonly ghosts: () => Ghost[],
    private readonly current: () => Ghost | undefined,
    private readonly desktop: HTMLElement,
  ) {}

  /** 起きているゴーストすべてに送る (GET) */
  private broadcast(id: string, refs: (string | number)[]): void {
    for (const g of this.ghosts()) if (g.alive && !g.leaving) void g.raise(id, refs);
  }

  start(): void {
    window.addEventListener('online', () => this.broadcast('OnNetworkStatusChange', this.networkRefs()));
    window.addEventListener('offline', () => this.broadcast('OnNetworkStatusChange', this.networkRefs()));
    darkMedia()?.addEventListener?.('change', () => this.broadcast('OnDarkTheme', this.darkRefs()));
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.broadcast('OnDisplayChange', this.displayRefs());
        this.broadcast('OnDisplayChangeEx', ['update', this.displayExRef()]);
      }, 500);
    });
    window.addEventListener('gamepadconnected', (e) => this.broadcast('OnGamepadConnected', [(e as GamepadEvent).gamepad.index]));
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads.delete((e as GamepadEvent).gamepad.index);
      this.broadcast('OnGamepadDisconnected', [(e as GamepadEvent).gamepad.index]);
    });
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    void nav
      .getBattery?.()
      .then((b) => {
        this.battery = b;
        this.lastBatteryFlags = this.batteryRefs()[3] as string;
        const changed = () => this.batteryChanged();
        b.addEventListener('levelchange', changed);
        b.addEventListener('chargingchange', changed);
      })
      .catch(() => undefined);
    this.setVoiceRecognition(settings.voiceRecognition ?? false);
  }

  // ---------------------------------------------------------------- 起動時の NOTIFY

  async bootNotices(g: Ghost): Promise<void> {
    const lang = navigator.language || 'ja-JP';
    // Engawa の画面は日本語だけ。SSP の標準の日本語は、言語名 Japanese・言語 ID 0 で届く
    // (kotori は Reference0 を content の Japanese / English と照らし合わせる)
    await g.notify('OnLanguageChange', ['Japanese', '0', '', '']);
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const dst = now.getTimezoneOffset() < Math.max(jan, jul) ? 1 : 0;
    await g.notify('OnNotifyInternationalInfo', [now.getTimezoneOffset(), dst, lang.split('-')[1] ?? '', lang.split('-')[0]]);
    const holiday = holidayRefs(now);
    if (holiday) await g.notify('OnNotifyHolidayInfo', holiday);
    await g.notify('OnNotifyFontInfo', availableFonts());
    await g.notify('OnNetworkStatusChange', this.networkRefs());
    await g.notify('OnDarkTheme', this.darkRefs());
    await g.notify('OnDisplayChange', this.displayRefs());
    await g.notify('OnDisplayChangeEx', ['init', this.displayExRef()]);
    if (this.battery) await g.notify('OnBatteryNotify', this.batteryRefs());
    await g.notify('OnSpeechSynthesisStatus', [settings.speech ? 1 : 0]);
    await g.notify('OnVoiceRecognitionStatus', [this.listening ? 1 : 0]);
    const pads = typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p) : [];
    for (const p of pads) await g.notify('OnGamepadConnected', [p.index]);
  }

  private networkRefs(): (string | number)[] {
    const c = (navigator as Navigator & { connection?: { type?: string; downlink?: number } }).connection;
    const online = navigator.onLine !== false;
    return [online ? 'online' : 'offline', '', online ? (c?.type ?? 'unknown') : 'none', c?.downlink !== undefined ? Math.round((c.downlink / 8) * 100) / 100 : -1];
  }

  private darkRefs(): number[] {
    const dark = darkMedia()?.matches ? 1 : 0;
    return [dark, dark];
  }

  private displayRefs(): number[] {
    return [screen.colorDepth || 24, this.desktop.clientWidth, this.desktop.clientHeight];
  }

  private displayExRef(): string {
    const w = this.desktop.clientWidth;
    const h = this.desktop.clientHeight;
    return [0, 0, w, h, screen.colorDepth || 24, 1, 'bottom', h].join(',');
  }

  // ---------------------------------------------------------------- バッテリー

  private batteryRefs(): (string | number)[] {
    const b = this.battery!;
    const percent = Math.round(b.level * 100);
    const flags = [percent >= 67 ? 'high' : '', percent <= 33 ? 'low' : '', percent <= 5 ? 'critical' : '', b.charging ? 'charging' : ''].filter(Boolean);
    const remain = !b.charging && Number.isFinite(b.dischargingTime) ? Math.round(b.dischargingTime) : -1;
    return [percent, remain, b.charging ? 'online' : 'offline', flags.join(',')];
  }

  private batteryChanged(): void {
    const refs = this.batteryRefs();
    const flags = String(refs[3]).split(',');
    const before = this.lastBatteryFlags.split(',');
    this.lastBatteryFlags = String(refs[3]);
    this.broadcast('OnBatteryNotify', refs);
    if (flags.includes('low') && !before.includes('low')) this.broadcast('OnBatteryLow', refs);
    if (flags.includes('critical') && !before.includes('critical')) this.broadcast('OnBatteryCritical', refs);
    if (flags.includes('charging') && !before.includes('charging')) this.broadcast('OnBatteryChargingStart', refs);
    if (!flags.includes('charging') && before.includes('charging')) this.broadcast('OnBatteryChargingStop', refs);
  }

  // ---------------------------------------------------------------- ゲームパッド (毎フレーム)

  tick(): void {
    if (typeof navigator.getGamepads !== 'function') return;
    for (const p of navigator.getGamepads()) {
      if (!p) continue;
      const prev = this.pads.get(p.index) ?? { buttons: [], axes: [0, 0, 0, 0, 0, 0] };
      const buttons = p.buttons.map((b) => b.pressed);
      for (const [i, name] of Object.entries(BUTTONS)) {
        const now = buttons[Number(i)] ?? false;
        const was = prev.buttons[Number(i)] ?? false;
        if (now !== was) this.broadcast(now ? 'OnGamepadButtonDown' : 'OnGamepadButtonUp', [p.index, name]);
      }
      // スティック (上を正にする) とトリガー
      const raw = [p.axes[0] ?? 0, -(p.axes[1] ?? 0), p.axes[2] ?? 0, -(p.axes[3] ?? 0), p.buttons[6]?.value ?? 0, p.buttons[7]?.value ?? 0];
      const names = ['LeftStickX', 'LeftStickY', 'RightStickX', 'RightStickY', 'LeftTrigger', 'RightTrigger'];
      const axes = raw.map((v) => (Math.abs(v) < DEADZONE ? 0 : Math.round(v * 1000) / 1000));
      axes.forEach((v, i) => {
        const was = prev.axes[i] ?? 0;
        if ((v === 0 && was !== 0) || Math.abs(v - was) >= AXIS_STEP) {
          const trigger = i >= 4;
          this.broadcast('OnGamepadAxisMove', [p.index, names[i], Math.round(v * (trigger ? 255 : 32767)), v]);
        } else axes[i] = was;
      });
      this.pads.set(p.index, { buttons, axes });
    }
  }

  // ---------------------------------------------------------------- 全員の重なり・見切れ (1秒ごと)

  second(): void {
    const items: { name: string; rect: { left: number; top: number; width: number; height: number } }[] = [];
    for (const g of this.ghosts()) {
      if (!g.alive || g.leaving || g.isMinimized) continue;
      for (const id of g.visibleScopes()) {
        const rect = g.scopeRect(id);
        if (rect) items.push({ name: `${g.sakuraName}/${id}`, rect });
      }
    }
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].rect;
        const b = items[j].rect;
        if (a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height) pairs.push(`${items[i].name}-${items[j].name}`);
      }
    }
    const overlap = pairs.join('\x01');
    if (overlap !== this.lastOverlap) {
      for (const g of this.ghosts()) if (g.alive && !g.leaving) void g.raise('OnOtherOverlap', [overlap, this.lastOverlap], { ifIdle: true });
      this.lastOverlap = overlap;
    }
    const w = this.desktop.clientWidth;
    const h = this.desktop.clientHeight;
    const off = items
      .filter(({ rect: r }) => r.left < 0 || r.top < 0 || r.left + r.width > w || r.top + r.height > h)
      .map((i) => i.name)
      .join('\x01');
    if (off !== this.lastOffscreen) {
      for (const g of this.ghosts()) if (g.alive && !g.leaving) void g.raise('OnOtherOffscreen', [off, this.lastOffscreen], { ifIdle: true });
      this.lastOffscreen = off;
    }
  }

  // ---------------------------------------------------------------- 音声

  /** 音声合成の入・切が変わった (オプション) */
  speechChanged(): void {
    this.broadcast('OnSpeechSynthesisStatus', [settings.speech ? 1 : 0]);
  }

  /** 音声認識 (Web Speech API。Chrome など)。認識した言葉を前面のゴーストに OnVoiceRecognitionWord で送る */
  setVoiceRecognition(on: boolean): void {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => NonNullable<EnvironmentEvents['recognition']>; webkitSpeechRecognition?: new () => NonNullable<EnvironmentEvents['recognition']> });
    const Rec = Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition;
    const was = this.listening;
    if (!on || !Rec) {
      this.listening = false;
      this.recognition?.abort();
      this.recognition = undefined;
      if (was) this.broadcast('OnVoiceRecognitionStatus', [0]);
      return;
    }
    if (this.recognition) return;
    const rec = new Rec();
    rec.lang = navigator.language || 'ja-JP';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const word = r.isFinal ? r[0].transcript.trim() : '';
        const g = this.current();
        if (word && g?.alive && !g.leaving) void g.raise('OnVoiceRecognitionWord', [0, word]);
      }
    };
    // 黙っていると止まるので、使う間はつなぎ直す
    rec.onend = () => {
      if (this.recognition === rec) {
        try {
          rec.start();
        } catch {
          // すでに動いている
        }
      }
    };
    rec.onerror = (e: { error?: string }) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.setVoiceRecognition(false);
    };
    this.recognition = rec;
    try {
      rec.start();
      this.listening = true;
      if (!was) this.broadcast('OnVoiceRecognitionStatus', [1]);
    } catch {
      this.recognition = undefined;
    }
  }
}
