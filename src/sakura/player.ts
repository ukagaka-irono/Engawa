import type { BalloonView, FontState, LineAlign, MarkerOverrides } from '../balloon/balloon-view';
import { markerStyle, type MarkerLook, type MarkerLooks } from '../balloon/skin';
import type { AlphaMode } from '../util/image';
import { tokenize, type Token } from './tokenizer';

/** \_b のオプション */
export interface InlineImageOptions {
  alpha: AlphaMode;
  /** --option=foreground: 文字の上に描く */
  foreground: boolean;
  /** --option=fixed: スクロールしても動かさない (座標指定のときだけ) */
  fixed: boolean;
  /** --clipping=左 上 右 下 */
  clip?: [number, number, number, number];
  /** --scaling=横 縦 / --scaling=大きさ long|short(max|min) */
  scaling?: string;
}

/** \_b の画像 (透過処理と切り抜きを済ませたもの) */
export interface InlineImage {
  url: string;
  width: number;
  height: number;
}

/** スクリプトの実行に必要な、ゴースト側の機能。 */
export interface PlayerHost {
  /** 1文字あたりの表示ウェイト (ms) */
  talkWait(): number;
  balloon(scope: number): BalloonView;
  showBalloon(scope: number): void;
  hideBalloon(scope: number): void;
  setBalloonId(scope: number, id: number): void;
  /** スクリプト開始時。\C が無ければ全バルーンを消す */
  beginScript(append: boolean): void;
  setSurface(scope: number, id: string): Promise<void>;
  playAnimation(scope: number, id: number): void;
  waitAnimation(scope: number, id: number): Promise<void>;
  talkChar(scope: number): void;
  yenE(): void;
  envVar(name: string): string;
  selectChoice(title: string, id: string, refs: string[]): void;
  selectAnchor(title: string, id: string, refs: string[]): void;
  /** 選択肢・アンカーにマウスが重なった (entering)・外れた */
  hoverLink?(kind: 'choice' | 'anchor', entering: boolean, title: string, id: string, refs: string[]): void;
  /** \![...] */
  command(args: string[], scope: number): Promise<void>;
  openCommunicate(): void;
  playSound(file: string, loop?: boolean): void;
  waitSound(): Promise<void>;
  /** \j[…] (http・https・mailto・file:///) */
  openUrl(url: string): void;
  /** \_b の画像。読めなければ undefined */
  imageUrl(path: string, opts: InlineImageOptions): Promise<InlineImage | undefined>;
  /** \4 (approach = false) / \5 (true)。そのスコープのキャラクターを相手から離す・相手に寄せる */
  moveScope(scope: number, approach: boolean): Promise<void>;
  /** \t の間はマウスのイベントを送らない */
  setTimeCritical(on: boolean): void;
  /** \![embed,イベント,r0…] の結果のスクリプト。無ければ undefined */
  embed(event: string, refs: string[]): Promise<string | undefined>;
  /** 音声合成で読み上げる (区切りごと。\__v で変えた読み) */
  speak(text: string): void;
}

export interface PlayResult {
  aborted: boolean;
  exited: boolean;
  /** \* があった (選択肢をタイムアウトさせない) */
  noTimeout: boolean;
  hasChoices: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' };

function parseBool(v: string | undefined): boolean | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return undefined;
}

/** 名前で書ける色 (default.* はバルーンの既定の色) */
const NAMED_DEFAULTS: Record<string, string> = {
  disable: 'var(--b-disable)',
  'default.anchor': 'var(--b-anchor)',
  'default.anchornotselect': 'var(--b-anchor)',
  'default.anchorvisited': 'var(--b-anchor)',
  'default.cursor': 'var(--balloon-cursor-text)',
  'default.cursornotselect': 'inherit',
  'default.plain': 'var(--b-color)',
};

/**
 * 色指定 (ukadoc の「文字色指定の方法」)。R,G,B・R%,G%,B%・#rgb / #rrggbb・色名・disable / default.*。
 * default は undefined (既定の色に戻す)、読めない値は null (無視して前の色のまま)
 */
export function parseColor(args: string[]): string | undefined | null {
  const [a = '', g, b] = args.map((s) => s.trim().toLowerCase());
  if (a === 'default' || a === '') return undefined;
  if (a in NAMED_DEFAULTS) return NAMED_DEFAULTS[a];
  if (g !== undefined && b !== undefined) {
    const parts = [a, g, b];
    if (parts.every((p) => /^\d+(\.\d+)?%$/.test(p))) return `rgb(${parts.join(', ')})`;
    if (parts.every((p) => /^\d+$/.test(p))) return `rgb(${parts.map((p) => Math.min(255, Number(p))).join(', ')})`;
    return null;
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(a)) return a;
  if (/^[0-9a-f]{6}$/.test(a)) return '#' + a;
  if (/^[a-z]+$/.test(a)) return a;
  return null;
}

/** \_u・\_m・\&[#…] の文字コード。Unicode に無い値 (小数・0x110000 以上など) は何も出さない */
function parseCode(v: string | undefined): string {
  const n = Number(v?.trim());
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** \n の引数 (half / パーセント) を行送り量にする */
function newlineRatio(arg: string): number {
  if (arg === 'half') return 0.5;
  const pct = Number(arg);
  return arg !== '' && Number.isFinite(pct) ? pct / 100 : 1;
}

/** \_b[ファイル,x,y,オプション…] / \_b[ファイル,inline,オプション…] */
function inlineImageOptions(args: string[]): InlineImageOptions {
  const opts = args.map((s) => s.trim());
  const lower = opts.map((s) => s.toLowerCase());
  const has = (name: string) => lower.includes(name) || lower.includes(`--option=${name}`);
  const value = (name: string) => opts.find((o) => o.toLowerCase().startsWith(`--${name}=`))?.slice(name.length + 3);
  const clip = value('clipping')
    ?.split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  return {
    alpha: has('opaque') ? 'none' : has('use_self_alpha') ? 'on' : 'off',
    foreground: has('foreground'),
    fixed: has('fixed'),
    clip: clip?.length === 4 ? (clip as [number, number, number, number]) : undefined,
    scaling: value('scaling'),
  };
}

/** --scaling を、表示する大きさにする (ukadoc の \_b のオプション)。負の数は反転 */
export function scaledSize(w: number, h: number, scaling: string | undefined): { width: number; height: number; flipX: boolean; flipY: boolean } | undefined {
  if (!scaling) return undefined;
  const limit = (n: number) => Math.min(4096, Math.max(1, Math.round(n)));
  const parts = scaling.trim().toLowerCase().split(/\s+/);
  const edge = /^(long|short)?(max|min)?$/.exec(parts[1] ?? '');
  if (parts.length === 2 && edge && (edge[1] || edge[2])) {
    const size = Number(parts[0]);
    if (!Number.isFinite(size) || size === 0) return undefined;
    const base = (edge[1] ?? 'long') === 'long' ? Math.max(w, h) : Math.min(w, h);
    let ratio = Math.abs(size) / base;
    if (edge[2] === 'max') ratio = Math.min(1, ratio);
    if (edge[2] === 'min') ratio = Math.max(1, ratio);
    return { width: limit(w * ratio), height: limit(h * ratio), flipX: size < 0, flipY: size < 0 };
  }
  const axis = (v: string | undefined, original: number): number | undefined => {
    if (v === undefined) return undefined;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return undefined;
    return v.endsWith('%') ? (original * n) / 100 : n;
  };
  let x = axis(parts[0], w);
  let y = axis(parts[1] ?? parts[0], h);
  if (x === undefined || y === undefined) return undefined;
  if (x === 0 && y !== 0) x = Math.sign(y) * Math.abs((w * y) / h);
  if (y === 0 && x !== 0) y = Math.sign(x) * Math.abs((h * x) / w);
  if (x === 0 || y === 0) return undefined;
  return { width: limit(Math.abs(x)), height: limit(Math.abs(y)), flipX: x < 0, flipY: y < 0 };
}

/** \f[cursor*] / \f[anchor*] の名前 → どのマーカーのどの値か */
const MARKER_FONT: Record<string, [keyof MarkerLooks, keyof MarkerLook]> = {};
for (const [prefix, look] of [
  ['cursor', 'cursor'],
  ['cursornotselect', 'cursorNot'],
  ['anchor', 'anchor'],
  ['anchornotselect', 'anchorNot'],
  ['anchorvisited', 'anchorVisited'],
] as const) {
  MARKER_FONT[`${prefix}style`] = [look, 'style'];
  MARKER_FONT[`${prefix}color`] = [look, 'bg'];
  MARKER_FONT[`${prefix}brushcolor`] = [look, 'bg'];
  MARKER_FONT[`${prefix}pencolor`] = [look, 'pen'];
  MARKER_FONT[`${prefix}fontcolor`] = [look, 'font'];
}

/** さくらスクリプトを1本ずつ実行する。新しいスクリプトを流すと前のものは中断される。 */
export class ScriptPlayer {
  playing = false;
  /** クリック待ち (\x) 中 */
  waitingClick = false;

  private gen = 0;
  private skipping = false;
  private waiter?: () => void;
  private clickWaiter?: () => void;
  /** 1文字のウェイトの倍率。ms が決まっていればそちら (\![set,balloonwait]) */
  private waitRate = 1;
  private waitMs?: number;
  /** クイックセクション (\_q・\![quicksection]) の中: 文字をウェイト無しで出す */
  private quickSection = false;
  /** 口パクのアニメーション (talk) を動かすか (\![set,serikotalk]) */
  private serikoTalk = true;

  constructor(private readonly host: PlayerHost) {}

  abort(): void {
    this.gen++;
    this.playing = false;
    this.waiter?.();
    this.clickWaiter?.();
  }

  /** バルーンのクリック。\x 待ちを解くか、残りのウェイトを飛ばす。 */
  skip(): void {
    if (this.clickWaiter) {
      this.clickWaiter();
      return;
    }
    if (this.playing) {
      this.skipping = true;
      this.waiter?.();
    }
  }

  async play(script: string): Promise<PlayResult> {
    this.abort();
    const gen = ++this.gen;
    const alive = () => gen === this.gen;
    const host = this.host;
    const tokens: Token[] = tokenize(script);
    const result: PlayResult = { aborted: false, exited: false, noTimeout: false, hasChoices: false };

    this.playing = true;
    this.skipping = false;
    this.waitRate = 1;
    this.waitMs = undefined;
    this.quickSection = false;
    this.serikoTalk = true;
    let scope = 0;
    let sync: number[] | null = null;
    let font: FontState = {};
    let start = performance.now();
    /** \__q / \_a の中: 表示した文字をタイトルとして集める */
    let link: { title: string } | null = null;
    const used = new Set<number>();
    /** 音声合成で読む文字列 (\__v[disable] の間は読まない、\__v[alternate,…] の間はその読み) */
    let spoken = '';
    let voice: { disabled: boolean; alternate?: string } | null = null;
    let timeCritical = false;

    const first = tokens[0];
    host.beginScript(first?.type === 'tag' && first.name === 'C');

    const balloonOf = (sc: number): BalloonView => {
      used.add(sc);
      const b = host.balloon(sc);
      if (!b.shown) host.showBalloon(sc);
      return b;
    };

    const out = async (str: string): Promise<void> => {
      if (!voice) spoken += str;
      for (const ch of str) {
        for (const sc of sync ?? [scope]) {
          balloonOf(sc).write(ch, font);
          if (this.serikoTalk) host.talkChar(sc);
        }
        if (link) link.title += ch;
        if (!this.quickSection) await this.wait(this.waitMs ?? host.talkWait() * this.waitRate);
        if (!alive()) return;
      }
    };

    const speakNow = () => {
      if (spoken.trim()) host.speak(spoken);
      spoken = '';
    };

    const finish = (): PlayResult => {
      this.finish(gen);
      speakNow();
      if (timeCritical) host.setTimeCritical(false);
      result.hasChoices = [...used].some((sc) => host.balloon(sc).hasChoices);
      return result;
    };

    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (!alive()) break;
      try {
        if (t.type === 'text') {
          await out(t.text);
          continue;
        }
        if (t.type === 'env') {
          // %* は \![*] と同じ
          if (t.name === '*') balloonOf(scope).marker();
          else await out(host.envVar(t.name));
          continue;
        }
        const a = t.args;
        switch (t.name) {
          case '0':
          case 'h':
            scope = 0;
            break;
          case '1':
          case 'u':
            scope = 1;
            break;
          case 'p':
            scope = Math.max(0, Number(a[0]) || 0);
            break;
          case 's':
            await host.setSurface(scope, a[0] ?? '0');
            break;
          case 'i':
            host.playAnimation(scope, Number(a[0]));
            if (a[1]?.trim() === 'wait') await this.cancellable(host.waitAnimation(scope, Number(a[0])));
            break;
          case 'b':
            if (Number(a[0]) === -1) host.hideBalloon(scope);
            else host.setBalloonId(scope, Number(a[0]) || 0);
            break;
          case 'n': {
            const ratio = newlineRatio(a.join(',').trim());
            for (const sc of sync ?? [scope]) host.balloon(sc).newline(ratio);
            link = null;
            break;
          }
          case '_n':
            // 次の \_n まで自動で折り返さない
            font = { ...font, noWrap: !font.noWrap || undefined };
            break;
          case 'w':
            await this.wait(Number(a[0]) * 50);
            break;
          case '_w':
            await this.wait(Number(a[0]) || 0);
            break;
          case '__w':
            if (a[0] === 'clear') start = performance.now();
            else if (a[0] === 'animation') await this.cancellable(host.waitAnimation(scope, Number(a[1])));
            else await this.wait(start + (Number(a[0]) || 0) - performance.now());
            break;
          case '_q':
            this.quickSection = !this.quickSection;
            break;
          case '_s':
            sync = sync ? null : a.length ? a.map(Number) : [0, 1];
            break;
          case 'e':
            host.yenE();
            return finish();
          case 'z':
            // [旧仕様] 選択肢のあるスクリプトの \e
            host.yenE();
            return finish();
          case '-':
            result.exited = true;
            return finish();
          case '*':
            result.noTimeout = true;
            break;
          case 'c': {
            const b = host.balloon(scope);
            const startAt = a[2] !== undefined && a[2].trim() !== '' ? Number(a[2]) : undefined;
            if (a[0] === 'char') b.deleteChars(Number(a[1]) || 1, startAt);
            else if (a[0] === 'line') b.deleteLines(Number(a[1]) || 1, startAt);
            else b.clear();
            break;
          }
          case 'x':
            speakNow();
            this.skipping = false;
            this.waitingClick = true;
            for (const sc of used) host.balloon(sc).setWaitingClick(true);
            await new Promise<void>((resolve) => (this.clickWaiter = resolve));
            this.clickWaiter = undefined;
            this.waitingClick = false;
            for (const sc of used) host.balloon(sc).setWaitingClick(false);
            if (!alive()) break;
            // \__w の基準は \x からも数える
            start = performance.now();
            if (a[0] !== 'noclear') {
              // クリック後はバルーンを消し、スコープは \0、\f の文字装飾も解除される
              for (const sc of used) host.balloon(sc).clear();
              scope = 0;
              font = {};
              link = null;
            }
            break;
          case 't':
            // タイムクリティカルセクション (\e まで、マウスのイベントを送らない)
            timeCritical = true;
            host.setTimeCritical(true);
            break;
          case '4':
          case '5':
            await host.moveScope(scope, t.name === '5');
            break;
          case '+':
            await host.command(['change', 'ghost', 'random'], scope);
            break;
          case '_+':
            await host.command(['change', 'ghost', 'sequential'], scope);
            break;
          case 'v':
            await host.command(['set', 'windowstate', 'stayontop'], scope);
            break;
          case 'a':
            await host.command(['raise', 'OnAITalk'], scope);
            break;
          case '__t':
            await host.command(['open', 'teachbox'], scope);
            break;
          case '__v': {
            // \__v[disable] / \__v[alternate,読み] … \__v
            const opt = a[0]?.trim().toLowerCase();
            if (a.length === 0 || !opt) {
              if (voice?.alternate) spoken += voice.alternate;
              voice = null;
            } else if (opt === 'disable') {
              voice = { disabled: true };
            } else if (opt === 'alternate') {
              voice = { disabled: false, alternate: a.slice(1).join(',') };
            }
            break;
          }
          case 'q': {
            const [title = '', id = '', ...refs] = a;
            if (!title.trim() && !id) break;
            balloonOf(scope).choice(
              title,
              font,
              () => host.selectChoice(title, id, refs),
              (on) => host.hoverLink?.('choice', on, title, id, refs),
            );
            break;
          }
          case '__q':
            if (a.length === 0) {
              host.balloon(scope).endLink();
              link = null;
            } else {
              const [id = '', ...refs] = a;
              const ctx = { title: '' };
              link = ctx;
              balloonOf(scope).beginLink('choice', () => host.selectChoice(ctx.title, id, refs), font, (on) => host.hoverLink?.('choice', on, ctx.title, id, refs));
            }
            break;
          case '_a':
            if (a.length === 0) {
              host.balloon(scope).endLink();
              link = null;
            } else {
              const [id = '', ...refs] = a;
              const ctx = { title: '' };
              link = ctx;
              balloonOf(scope).beginLink('anchor', () => host.selectAnchor(ctx.title, id, refs), font, (on) => host.hoverLink?.('anchor', on, ctx.title, id, refs));
            }
            break;
          case 'f': {
            const align = this.alignOf(a);
            if (align) for (const sc of sync ?? [scope]) balloonOf(sc).setAlign(align);
            else font = this.applyFont(font, a);
            break;
          }
          case '_l':
            balloonOf(scope).locate(a[0], a[1]);
            break;
          case '_b': {
            const inline = a[1]?.trim().toLowerCase() === 'inline';
            const opts = inlineImageOptions(a.slice(inline ? 2 : 3));
            const img = await host.imageUrl(a[0] ?? '', opts);
            if (!img || !alive()) break;
            const size = scaledSize(img.width, img.height, opts.scaling);
            balloonOf(scope).image(
              img.url,
              inline ? undefined : { x: Number(a[1]) || 0, y: Number(a[2]) || 0, foreground: opts.foreground, fixed: opts.fixed },
              size,
            );
            break;
          }
          case '&': {
            const name = (a[0] ?? '').trim();
            const ch = name.startsWith('#') ? parseCode(name.startsWith('#x') ? '0' + name.slice(1) : name.slice(1)) : ENTITIES[name];
            if (ch) await out(ch);
            break;
          }
          case '_u':
          case '_m':
            await out(parseCode(a[0]));
            break;
          case '!': {
            const cmd = (a[0] ?? '').trim().toLowerCase();
            if (cmd === '*') {
              balloonOf(scope).marker();
            } else if (cmd === 'embed') {
              // イベントの結果を、このタグの位置に差し込んで続ける
              const value = a[1] ? await host.embed(a[1].trim(), a.slice(2)) : undefined;
              if (!alive()) break;
              if (value) tokens.splice(ti + 1, 0, ...tokenize(value));
            } else {
              await this.command(a, scope);
            }
            break;
          }
          case '8':
          case '_v':
            host.playSound(a[0] ?? '');
            break;
          case '_V':
            await this.cancellable(host.waitSound());
            break;
          case 'j':
            if (a[0]) host.openUrl(a[0].trim());
            break;
          case '__c':
            host.openCommunicate();
            break;
          default:
            // \6 \7 (時計合わせ) \m (ウインドウメッセージ) \C などは読み飛ばす
            break;
        }
      } catch (e) {
        // 1つのタグで失敗しても、再生中のまま止まらないよう次へ進む
        console.warn('[sakura]', t, e);
      }
    }
    if (!alive()) {
      result.aborted = true;
      return result;
    }
    host.yenE();
    return finish();
  }

  private finish(gen: number): void {
    if (gen === this.gen) this.playing = false;
  }

  private async command(a: string[], scope: number): Promise<void> {
    const [cmd = '', sub = ''] = a.map((s) => s.trim().toLowerCase());
    // \![quicksection,true|1] / \![quicksection,false|0]: \_q と同じクイックセクションを、切り替えでなく開始・終了で指定する
    if (cmd === 'quicksection') {
      this.quickSection = sub === 'true' || sub === '1';
      return;
    }
    if (cmd === 'set' && sub === 'balloonwait') {
      this.setBalloonWait(a[2]?.trim() ?? '');
      return;
    }
    if (cmd === 'set' && sub === 'serikotalk') {
      this.serikoTalk = parseBool(a[2]) !== false;
      return;
    }
    if (cmd === 'sound' && sub === 'wait') {
      await this.cancellable(this.host.waitSound());
      return;
    }
    await this.host.command(a, scope);
  }

  /**
   * \![set,balloonwait,倍率]。数値は倍率 (0〜100)、% 付きは百分率 (0〜10000)、ms 付きは1文字の待ち (0〜10000)。
   * 省略か 1 で既定に戻す
   */
  private setBalloonWait(v: string): void {
    this.waitMs = undefined;
    this.waitRate = 1;
    if (!v) return;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return;
    if (v.toLowerCase().endsWith('ms')) this.waitMs = Math.min(10_000, Math.max(0, n));
    else if (v.endsWith('%')) this.waitRate = Math.min(10_000, Math.max(0, n)) / 100;
    else this.waitRate = Math.min(100, Math.max(0, n));
  }

  /** \f[align,…] なら揃え方 */
  private alignOf(a: string[]): LineAlign | undefined {
    if ((a[0] ?? '').trim().toLowerCase() !== 'align') return undefined;
    const v = (a[1] ?? '').trim().toLowerCase();
    return v === 'center' || v === 'right' ? v : 'left';
  }

  private applyFont(font: FontState, a: string[]): FontState {
    const [rawName = '', ...rest] = a.map((s) => s.trim());
    const name = rawName.toLowerCase();
    const f: FontState = { ...font };
    const color = (set: (c: string | undefined) => void) => {
      const c = parseColor(rest);
      if (c !== null) set(c);
    };
    const flag = (set: (v: boolean | undefined) => void) => {
      const v = (rest[0] ?? '').toLowerCase();
      // default はバルーンの既定に、disable は無効の文字と同じに
      if (v === 'default' || v === 'disable') set(undefined);
      else {
        const b = parseBool(rest[0]);
        if (b !== undefined) set(b);
      }
    };
    switch (name) {
      case 'default':
        // マーカーの指定はそのまま残す (\f[default] は文字の書式を戻すもの)
        return f.marker ? { marker: f.marker } : {};
      case 'disable':
        return { disabled: true, marker: f.marker };
      case 'color':
        color((c) => (f.color = c));
        break;
      case 'height': {
        const v = rest[0] ?? 'default';
        if (v === 'default') f.size = undefined;
        else if (/^[+-]/.test(v)) f.size = Math.max(4, (f.size ?? 13) + Number(v));
        else f.size = Number(v) || undefined;
        break;
      }
      case 'bold':
        flag((v) => (f.bold = v));
        break;
      case 'italic':
        flag((v) => (f.italic = v));
        break;
      case 'underline':
        flag((v) => (f.underline = v));
        break;
      case 'strike':
        flag((v) => (f.strike = v));
        break;
      case 'sub':
        flag((v) => (f.sub = v));
        break;
      case 'sup':
        flag((v) => (f.sup = v));
        break;
      case 'outline':
        flag((v) => (f.outline = v));
        break;
      case 'name':
      case 'face':
        f.family = rest[0] && rest[0] !== 'default' ? rest[0] : undefined;
        break;
      case 'valign': {
        const v = (rest[0] ?? '').toLowerCase();
        f.valign = v === 'top' || v === 'center' || v === 'bottom' ? v : undefined;
        break;
      }
      case 'shadowcolor':
        if ((rest[0] ?? '').toLowerCase() === 'none') f.shadow = 'none';
        else color((c) => (f.shadow = c));
        break;
      case 'shadowstyle': {
        const v = (rest[0] ?? '').toLowerCase();
        f.shadowStyle = v === 'offset' || v === 'outline' ? v : undefined;
        break;
      }
      case 'anchor.font.color':
        color((c) => (f.anchorColor = c));
        break;
      default: {
        const target = MARKER_FONT[name];
        if (!target) break;
        const [look, prop] = target;
        const marker: MarkerOverrides = { ...f.marker, [look]: { ...f.marker?.[look] } };
        const entry = marker[look]!;
        if (prop === 'style') {
          const v = (rest[0] ?? '').toLowerCase();
          entry.style = v === 'default' || !v ? undefined : markerStyle(v, 'none');
        } else {
          color((c) => (entry[prop] = c));
        }
        f.marker = marker;
      }
    }
    return f;
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0 || this.skipping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.waiter === done) this.waiter = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiter = done;
    });
  }

  /** p の完了を待つ。バルーンのクリック (skip) や中断 (abort) でも待つのをやめる */
  private cancellable(p: Promise<void>): Promise<void> {
    if (this.skipping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.waiter === done) this.waiter = undefined;
        resolve();
      };
      this.waiter = done;
      p.then(done, done);
    });
  }
}
