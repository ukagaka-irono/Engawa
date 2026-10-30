import type { BalloonView, FontState } from '../balloon/balloon-view';
import type { AlphaMode } from '../util/image';
import { tokenize } from './tokenizer';

/** \_b のオプション */
export interface InlineImageOptions {
  alpha: AlphaMode;
  /** --option=foreground: 文字の上に描く */
  foreground: boolean;
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
  /** \![...] */
  command(args: string[], scope: number): Promise<void>;
  openCommunicate(): void;
  playSound(file: string, loop?: boolean): void;
  waitSound(): Promise<void>;
  openUrl(url: string): void;
  /** \_b の画像 (透過処理済み) の URL。読めなければ undefined */
  imageUrl(path: string, opts: InlineImageOptions): Promise<string | undefined>;
}

export interface PlayResult {
  aborted: boolean;
  exited: boolean;
  /** \* があった (選択肢をタイムアウトさせない) */
  noTimeout: boolean;
  hasChoices: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' };

function parseBool(v: string | undefined): boolean | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return undefined;
}

function parseColor(args: string[]): string | undefined {
  const [a, g, b] = args.map((s) => s.trim());
  if (!a || a === 'default' || a === 'none' || a === 'disable') return undefined;
  if (g !== undefined && b !== undefined) return `rgb(${Number(a)}, ${Number(g)}, ${Number(b)})`;
  if (/^#?[0-9a-f]{6}$/i.test(a)) return a.startsWith('#') ? a : '#' + a;
  return a;
}

function parseCode(v: string | undefined): string {
  const n = Number(v?.trim());
  return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
}

/** \n の引数 (half / パーセント) を行送り量にする */
function newlineRatio(arg: string): number {
  if (arg === 'half') return 0.5;
  const pct = Number(arg);
  return arg !== '' && Number.isFinite(pct) ? pct / 100 : 1;
}

/** \_b[ファイル,x,y,オプション…] / \_b[ファイル,inline,オプション…] */
function inlineImageOptions(args: string[]): InlineImageOptions {
  const opts = args.map((s) => s.trim().toLowerCase());
  const has = (name: string) => opts.includes(name) || opts.includes(`--option=${name}`);
  return {
    alpha: has('opaque') ? 'none' : has('use_self_alpha') ? 'on' : 'off',
    foreground: has('foreground'),
  };
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
  private waitRate = 1;
  /** クイックセクション (\_q・\![quicksection]) の中: 文字をウェイト無しで出す */
  private quickSection = false;

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
    const tokens = tokenize(script);
    const result: PlayResult = { aborted: false, exited: false, noTimeout: false, hasChoices: false };

    this.playing = true;
    this.skipping = false;
    this.waitRate = 1;
    this.quickSection = false;
    let scope = 0;
    let sync: number[] | null = null;
    let font: FontState = {};
    let start = performance.now();
    /** \__q / \_a の中: 表示した文字をタイトルとして集める */
    let link: { title: string } | null = null;
    const used = new Set<number>();

    const first = tokens[0];
    host.beginScript(first?.type === 'tag' && first.name === 'C');

    const balloonOf = (sc: number): BalloonView => {
      used.add(sc);
      const b = host.balloon(sc);
      if (!b.shown) host.showBalloon(sc);
      return b;
    };

    const out = async (str: string): Promise<void> => {
      for (const ch of str) {
        for (const sc of sync ?? [scope]) {
          balloonOf(sc).write(ch, font);
          host.talkChar(sc);
        }
        if (link) link.title += ch;
        if (!this.quickSection) await this.wait(host.talkWait() * this.waitRate);
        if (!alive()) return;
      }
    };

    const finish = (): PlayResult => {
      this.finish(gen);
      result.hasChoices = [...used].some((sc) => host.balloon(sc).hasChoices);
      return result;
    };

    for (const t of tokens) {
      if (!alive()) break;
      if (t.type === 'text') {
        await out(t.text);
        continue;
      }
      if (t.type === 'env') {
        await out(host.envVar(t.name));
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
        case '-':
          result.exited = true;
          return finish();
        case '*':
          result.noTimeout = true;
          break;
        case 'c': {
          const b = host.balloon(scope);
          if (a[0] === 'char') b.deleteChars(Number(a[1]) || 1);
          else if (a[0] === 'line') b.deleteLines(Number(a[1]) || 1);
          else b.clear();
          break;
        }
        case 'x':
          this.skipping = false;
          this.waitingClick = true;
          await new Promise<void>((resolve) => (this.clickWaiter = resolve));
          this.clickWaiter = undefined;
          this.waitingClick = false;
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
        case 'q': {
          const [title = '', id = '', ...refs] = a;
          if (!title.trim() && !id) break;
          balloonOf(scope).choice(title, font, () => host.selectChoice(title, id, refs));
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
            balloonOf(scope).beginLink('choice', () => host.selectChoice(ctx.title, id, refs));
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
            balloonOf(scope).beginLink('anchor', () => host.selectAnchor(ctx.title, id, refs));
          }
          break;
        case 'f':
          font = this.applyFont(font, a);
          break;
        case '_l':
          balloonOf(scope).locate(a[0], a[1]);
          break;
        case '_b': {
          const inline = a[1]?.trim().toLowerCase() === 'inline';
          const opts = inlineImageOptions(a.slice(inline ? 2 : 3));
          const url = await host.imageUrl(a[0] ?? '', opts);
          if (!url || !alive()) break;
          balloonOf(scope).image(url, inline ? undefined : { x: Number(a[1]) || 0, y: Number(a[2]) || 0, foreground: opts.foreground });
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
        case '!':
          await this.command(a, scope);
          break;
        case '8':
        case '_v':
          host.playSound(a[0] ?? '');
          break;
        case '_V':
          await this.cancellable(host.waitSound());
          break;
        case 'j':
          if (/^https?:\/\//i.test(a[0] ?? '')) host.openUrl(a[0]);
          break;
        case '__c':
          host.openCommunicate();
          break;
        default:
          // \t \v \4 \5 \6 \7 \z \_n \C などは表示に影響しないので読み飛ばす
          break;
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
      this.waitRate = Math.max(0, Number(a[2]) || 1);
      return;
    }
    if (cmd === 'sound' && sub === 'wait') {
      await this.cancellable(this.host.waitSound());
      return;
    }
    await this.host.command(a, scope);
  }

  private applyFont(font: FontState, a: string[]): FontState {
    const [name = '', ...rest] = a.map((s) => s.trim());
    const f = { ...font };
    switch (name.toLowerCase()) {
      case 'default':
        return {};
      case 'color':
        f.color = parseColor(rest);
        break;
      case 'height': {
        const v = rest[0] ?? 'default';
        if (v === 'default') f.size = undefined;
        else if (/^[+-]/.test(v)) f.size = Math.max(4, (f.size ?? 13) + Number(v));
        else f.size = Number(v) || undefined;
        break;
      }
      case 'bold':
        f.bold = parseBool(rest[0]);
        break;
      case 'italic':
        f.italic = parseBool(rest[0]);
        break;
      case 'underline':
        f.underline = parseBool(rest[0]);
        break;
      case 'strike':
        f.strike = parseBool(rest[0]);
        break;
      case 'sub':
        f.sub = parseBool(rest[0]);
        break;
      case 'sup':
        f.sup = parseBool(rest[0]);
        break;
      case 'name':
      case 'face':
        f.family = rest[0] && rest[0] !== 'default' ? rest[0] : undefined;
        break;
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
