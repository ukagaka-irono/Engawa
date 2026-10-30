import type { Bitmap } from '../util/image';
import type { BalloonKind, BalloonSkin, MarkerLook, MarkerLooks } from './skin';

/** \f[cursor*] / \f[anchor*] などでスクリプトが変えたマーカーの見た目 (指定したものだけ) */
export type MarkerOverrides = { [K in keyof MarkerLooks]?: Partial<MarkerLook> };

/** \f[...] で変わる文字の書式。undefined はバルーンの既定値。 */
export interface FontState {
  color?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  family?: string;
  sub?: boolean;
  sup?: boolean;
  /** \f[valign] */
  valign?: 'top' | 'center' | 'bottom';
  /** \f[shadowcolor]。'none' で陰落ちなし */
  shadow?: string;
  /** \f[shadowstyle] */
  shadowStyle?: 'offset' | 'outline';
  /** \f[outline] (白抜き) */
  outline?: boolean;
  /** \f[disable] (無効な文字の見た目) */
  disabled?: boolean;
  /** \_n の間 (自動で折り返さない) */
  noWrap?: boolean;
  /** \f[anchor.font.color] (アンカーの文字の色) */
  anchorColor?: string;
  marker?: MarkerOverrides;
}

/** 行揃え (\f[align]) */
export type LineAlign = 'left' | 'center' | 'right';

function fontKey(f: FontState): string {
  return JSON.stringify(f);
}

/** text-shadow の値。offset は右下にずらし、outline は四方に縁取る */
function textShadow(color: string, style: 'offset' | 'outline'): string {
  if (style === 'outline') return [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => `${x}px ${y}px 0 ${color}`)).join(', ');
  return `1px 1px 0 ${color}`;
}

function applyFont(el: HTMLElement, f: FontState): void {
  const s = el.style;
  if (f.color) s.color = f.color;
  if (f.disabled) s.color = 'var(--b-disable)';
  if (f.size) s.fontSize = `${f.size}px`;
  if (f.bold !== undefined) s.fontWeight = f.bold ? 'bold' : 'normal';
  if (f.italic !== undefined) s.fontStyle = f.italic ? 'italic' : 'normal';
  if (f.underline !== undefined || f.strike !== undefined) {
    const deco = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean).join(' ');
    s.textDecoration = deco || 'none';
  }
  if (f.family) s.fontFamily = `"${f.family.replace(/"/g, '')}", var(--font-balloon)`;
  if (f.sub) s.verticalAlign = 'sub';
  if (f.sup) s.verticalAlign = 'super';
  if (f.sub || f.sup) s.fontSize = '0.75em';
  if (f.valign) s.verticalAlign = f.valign === 'center' ? 'middle' : f.valign;
  if (f.shadow) s.textShadow = f.shadow === 'none' ? 'none' : textShadow(f.shadow, f.shadowStyle ?? 'offset');
  else if (f.shadowStyle) s.textShadow = textShadow('var(--b-shadow-color)', f.shadowStyle);
  if (f.outline !== undefined) {
    // 白抜き: 文字の色で縁取り、中を抜く
    s.setProperty('-webkit-text-stroke', f.outline ? '1px currentColor' : '0');
    s.setProperty('-webkit-text-fill-color', f.outline ? 'transparent' : 'currentColor');
  }
  if (f.noWrap) s.whiteSpace = 'pre';
}

/** マーカーの見た目を、リンクの要素の CSS 変数と属性にする (sel = 選んでいるとき、rest = それ以外) */
function applyMarker(a: HTMLElement, sel: MarkerLook, rest: MarkerLook): void {
  a.dataset.sel = sel.style;
  a.dataset.rest = rest.style;
  const s = a.style;
  s.setProperty('--sel-bg', sel.bg);
  s.setProperty('--sel-pen', sel.pen);
  s.setProperty('--sel-font', sel.font);
  s.setProperty('--rest-bg', rest.bg);
  s.setProperty('--rest-pen', rest.pen);
  s.setProperty('--rest-font', rest.font);
}

function mergeLook(base: MarkerLook, over: Partial<MarkerLook> | undefined): MarkerLook {
  return over ? { ...base, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) } : base;
}

const DRAG_THRESHOLD = 4;

/** 1つのバルーン (scope ごとに1つ)。テキストは DOM で組む。 */
export class BalloonView {
  readonly el = document.createElement('div');
  balloonId = 0;
  rightSide = false;
  shown = false;
  scale = 1;
  /** 自動でスクロールしない (\![set,autoscroll,disable]) */
  autoScroll = true;
  /** 利用者がドラッグで動かした量 (バルーンの位置に足す) */
  readonly userOffset = { x: 0, y: 0 };
  /** 利用者のドラッグで動かせない (\![lock,balloonmove]、descript の balloon.dontmove) */
  dragLocked = false;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** ドラッグで動かし終えた */
  onMoved?: () => void;

  private readonly inner = document.createElement('div');
  private readonly bg = document.createElement('canvas');
  private readonly text = document.createElement('div');
  private readonly decor = document.createElement('div');
  private block!: HTMLElement;
  private line!: HTMLElement;
  private span?: HTMLSpanElement;
  private spanKey = '';
  private link?: HTMLElement;
  private skin!: BalloonSkin;
  private chars = 0;
  /** \![lock,balloonrepaint] の間 (書いたものを見せない) */
  private repaintLocked = false;
  private waitingClick = false;
  private sstp?: { marker: boolean; message: string };
  private online = false;
  private onlineTimer?: number;
  private onlineFrame = 0;
  private number?: { name: string; current: string; max: string };
  private left = 0;
  private top = 0;
  private dragged = false;

  constructor(
    desktop: HTMLElement,
    readonly kind: BalloonKind,
    readonly scope: number,
  ) {
    this.el.className = 'balloon';
    this.el.dataset.kind = kind;
    this.el.hidden = true;
    this.inner.className = 'balloon-inner';
    this.text.className = 'balloon-text';
    this.text.setAttribute('aria-live', 'polite');
    this.decor.className = 'balloon-decor';
    this.decor.setAttribute('aria-hidden', 'true');
    this.inner.append(this.bg, this.text, this.decor);
    this.el.appendChild(this.inner);
    desktop.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.choice, .anchor')) return;
      if (this.dragged) {
        this.dragged = false;
        return;
      }
      this.onClick?.();
    });
    this.el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.choice, .anchor')) return;
      this.onDoubleClick?.();
    });
    this.text.addEventListener('scroll', () => this.updateArrows());
    this.bindDrag();
    this.clear();
  }

  get width(): number {
    return this.skin.size(this.kind, this.balloonId, this.rightSide)[0] * this.scale;
  }

  get height(): number {
    return this.skin.size(this.kind, this.balloonId, this.rightSide)[1] * this.scale;
  }

  get hasChoices(): boolean {
    return this.text.querySelector('.choice') !== null;
  }

  get length(): number {
    return this.chars;
  }

  /** 表示しているテキスト (OnBalloonBreak などに渡す) */
  get textContent(): string {
    return this.text.textContent ?? '';
  }

  setSkin(skin: BalloonSkin): void {
    this.skin = skin;
    this.redraw();
  }

  /** 今の画像に効くフォントやカーソルの設定を CSS 変数に移す */
  private applyStyle(): void {
    const st = this.skin.style(this.kind, this.balloonId, this.rightSide);
    const s = this.el.style;
    s.setProperty('--b-font', st.fontFamily);
    s.setProperty('--b-size', `${st.fontSize}px`);
    s.setProperty('--b-weight', st.fontBold ? 'bold' : 'normal');
    s.setProperty('--b-style', st.fontItalic ? 'italic' : 'normal');
    s.setProperty('--b-decoration', [st.fontUnderline && 'underline', st.fontStrike && 'line-through'].filter(Boolean).join(' ') || 'none');
    s.setProperty('--b-color', st.color);
    s.setProperty('--b-anchor', st.anchorColor);
    s.setProperty('--b-disable', st.disableColor);
    s.setProperty('--b-shadow-color', st.shadowColor ?? 'transparent');
    s.setProperty('--b-shadow', st.shadowColor ? textShadow(st.shadowColor, st.shadowStyle) : 'none');
    s.setProperty('--b-stroke', st.fontOutline ? '1px currentColor' : '0');
    s.setProperty('--b-fill', st.fontOutline ? 'transparent' : 'currentColor');
  }

  setBalloon(id: number): void {
    this.balloonId = id;
    this.redraw();
  }

  setSide(rightSide: boolean): void {
    if (this.rightSide === rightSide) return;
    this.rightSide = rightSide;
    this.redraw();
  }

  moveTo(left: number, top: number): void {
    this.left = left;
    this.top = top;
    this.applyPosition();
  }

  private applyPosition(): void {
    this.el.style.transform = `translate(${Math.round(this.left + this.userOffset.x)}px, ${Math.round(this.top + this.userOffset.y)}px)`;
  }

  /** 利用者がドラッグで動かした量を戻す (\![execute,resetballoonpos]) */
  resetUserOffset(): void {
    this.userOffset.x = 0;
    this.userOffset.y = 0;
    this.applyPosition();
  }

  show(): void {
    this.shown = true;
    this.el.hidden = false;
    this.updateArrows();
  }

  hide(): void {
    this.shown = false;
    this.el.hidden = true;
  }

  clear(): void {
    this.text.replaceChildren();
    this.block = this.text;
    this.link = undefined;
    this.chars = 0;
    this.newLine();
    this.updateArrows();
  }

  write(str: string, font: FontState): void {
    const key = fontKey(font);
    const parent = this.link ?? this.line;
    if (!this.span || this.spanKey !== key || this.span.parentElement !== parent) {
      this.span = document.createElement('span');
      applyFont(this.span, font);
      this.markPending(this.span);
      parent.appendChild(this.span);
      this.spanKey = key;
    }
    this.span.append(str);
    this.chars += str.length;
    this.scrollToEnd();
  }

  /** \n。ratio は \n[half] や \n[150] の行送り量 (1 = 1行、負の値は上へ戻る)。行揃えは左に戻る */
  newline(ratio = 1): void {
    this.endLink();
    if (this.line.childNodes.length === 0) {
      // 空の行は高さを持たないので、その行自体の高さで送る (負の値は次の行を上へずらす)
      if (ratio >= 0) {
        this.line.style.minHeight = `calc(${ratio} * var(--b-line))`;
        this.newLine();
      } else {
        this.newLine();
        this.line.style.marginTop = `calc(${ratio} * var(--b-line))`;
      }
      return;
    }
    this.newLine();
    if (ratio !== 1) this.line.style.marginTop = `calc(${ratio - 1} * var(--b-line))`;
  }

  /** \f[align]。今の行 (次の改行まで) の揃え方。既に書いた文字もそろえる */
  setAlign(align: LineAlign): void {
    this.line.style.textAlign = align;
  }

  /** \q[title,id] (1つの選択肢を一度に置く) */
  choice(title: string, font: FontState, onSelect: () => void, onHover?: (entering: boolean) => void): void {
    this.beginLink('choice', onSelect, font, onHover);
    this.write(title, font);
    this.endLink();
  }

  /** \__q / \_a の開始。以降の write はこの中に入る。 */
  beginLink(kind: 'choice' | 'anchor', onSelect: () => void, font: FontState = {}, onHover?: (entering: boolean) => void): void {
    this.endLink();
    const a = document.createElement('a');
    a.className = kind;
    a.tabIndex = 0;
    a.setAttribute('role', 'button');
    const markers = this.skin.style(this.kind, this.balloonId, this.rightSide).markers;
    const o = font.marker ?? {};
    if (kind === 'choice') {
      applyMarker(a, mergeLook(markers.cursor, o.cursor), mergeLook(markers.cursorNot, o.cursorNot));
    } else {
      const rest = mergeLook(markers.anchorNot, { font: font.anchorColor, ...o.anchorNot });
      applyMarker(a, mergeLook(markers.anchor, { font: font.anchorColor, ...o.anchor }), rest);
      const visited = mergeLook(markers.anchorVisited, o.anchorVisited);
      a.addEventListener('click', () => {
        a.classList.add('visited');
        applyMarker(a, mergeLook(markers.anchor, { font: font.anchorColor, ...o.anchor }), visited);
      });
    }
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect();
    });
    // 選択肢・アンカーに重なった・外れた (OnChoiceEnter / OnAnchorEnter)
    if (onHover) {
      a.addEventListener('pointerenter', () => onHover(true));
      a.addEventListener('pointerleave', () => onHover(false));
      a.addEventListener('focus', () => onHover(true));
      a.addEventListener('blur', () => onHover(false));
    }
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        a.click();
      }
    });
    this.markPending(a);
    this.line.appendChild(a);
    this.link = a;
    this.span = undefined;
  }

  endLink(): void {
    if (!this.link) return;
    this.link = undefined;
    this.span = undefined;
  }

  /** \_l[x,y]。数値は文字領域の左上からの px、`@` 付きは現在位置からの相対。行揃えは左に戻る */
  locate(xArg: string | undefined, yArg: string | undefined): void {
    this.endLink();
    const cur = this.cursor();
    const em = this.lineHeight() / Number(getComputedStyle(this.el).getPropertyValue('--leading') || 1.5);
    const resolve = (arg: string | undefined, current: number, center: number, origin: number): number => {
      if (arg === undefined || arg.trim() === '') return current;
      const a = arg.trim().toLowerCase();
      // centerx / centery はバルーン画像の中央 (文字の領域の左上ではなく画像が基準)
      if (a === 'centerx' || a === 'centery') return center - origin;
      const rel = a.startsWith('@');
      const body = rel ? a.slice(1) : a;
      const n = parseFloat(body);
      if (!Number.isFinite(n)) return current;
      const px = body.endsWith('em') ? n * em : body.endsWith('lh') ? n * this.lineHeight() : body.endsWith('%') ? (n / 100) * em : n;
      return rel ? current + px : px;
    };
    const [w, h] = this.skin.size(this.kind, this.balloonId, this.rightSide);
    const r = this.skin.textRect(this.kind, this.balloonId, this.rightSide, w, h);
    const x = resolve(xArg, cur.x, w / 2, r.left);
    const y = resolve(yArg, cur.y, h / 2, r.top);
    const block = document.createElement('div');
    block.className = 'balloon-block';
    block.style.left = `${x}px`;
    block.style.top = `${y}px`;
    block.style.width = `${Math.max(0, this.text.clientWidth / this.scale - x)}px`;
    this.text.appendChild(block);
    this.block = block;
    this.newLine();
  }

  /**
   * \_b[file,inline] など。インラインか、文字領域内の座標に置く。
   * 座標指定の画像は文字の下に描く (foreground なら上)。fixed ならスクロールしても動かさない。
   */
  image(url: string, at?: { x: number; y: number; foreground: boolean; fixed?: boolean }, size?: { width: number; height: number; flipX: boolean; flipY: boolean }): void {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    if (size) {
      img.style.width = `${size.width}px`;
      img.style.height = `${size.height}px`;
      if (size.flipX || size.flipY) img.style.transform = `scale(${size.flipX ? -1 : 1}, ${size.flipY ? -1 : 1})`;
    }
    this.markPending(img);
    if (!at) {
      img.className = 'balloon-inline-image';
      (this.link ?? this.line).appendChild(img);
      this.span = undefined;
      // \c[char] では1文字として数える
      this.chars++;
    } else {
      img.className = at.foreground ? 'balloon-image balloon-image-front' : 'balloon-image';
      img.style.left = `${at.x}px`;
      img.style.top = `${at.y}px`;
      if (at.fixed) {
        img.classList.add('balloon-image-fixed');
        this.decor.appendChild(img);
        const r = this.textOrigin();
        img.style.left = `${r.left + at.x}px`;
        img.style.top = `${r.top + at.y}px`;
      } else {
        this.text.appendChild(img);
      }
    }
    this.scrollToEnd();
  }

  /** \![*]。バルーンのマーカー画像 (無ければ ◆) を文字として置く */
  marker(): void {
    const img = this.skin.partImage(this.kind, 'marker.filename', 'marker');
    if (img) {
      const el = this.partElement(img);
      el.className = 'balloon-inline-image';
      (this.link ?? this.line).appendChild(el);
      this.span = undefined;
      this.chars++;
    } else {
      this.write('◆', {});
    }
  }

  /** \c[char,n] / \c[char,n,開始位置]。開始位置が無ければ末尾から n 文字 (インラインの画像も1文字) */
  deleteChars(n: number, start?: number): void {
    const units: (Text | HTMLElement)[] = [];
    const walker = document.createTreeWalker(this.text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node instanceof Text) units.push(node);
      else if (node instanceof HTMLElement && node.classList.contains('balloon-inline-image')) units.push(node);
    }
    // 文字ごとの位置 (どのノードの何文字目か) に並べる
    const chars: { node: Text | HTMLElement; index: number }[] = [];
    for (const u of units) {
      if (u instanceof Text) for (let i = 0; i < u.data.length; i++) chars.push({ node: u, index: i });
      else chars.push({ node: u, index: 0 });
    }
    const from = start === undefined ? Math.max(0, chars.length - n) : Math.max(0, start);
    const doomed = chars.slice(from, from + n);
    // 後ろから消す (前を消すと同じテキストノードの位置がずれるため)
    for (const c of doomed.reverse()) {
      if (c.node instanceof Text) c.node.deleteData(c.index, 1);
      else c.node.remove();
      this.chars--;
    }
    this.chars = Math.max(0, this.chars);
  }

  /** \c[line,n] / \c[line,n,開始位置]。中身のない行は数えない */
  deleteLines(n: number, start?: number): void {
    const lines = [...this.text.querySelectorAll<HTMLElement>('.balloon-line')].filter((l) => l.childNodes.length > 0 || l === this.line);
    const from = start === undefined ? Math.max(0, lines.length - n) : Math.max(0, start);
    lines.slice(from, from + n).forEach((l) => l.remove());
    if (!this.line.isConnected) {
      this.block = this.text;
      this.newLine();
    }
  }

  // ---------------------------------------------------------------- スクリプトが付けるもの

  /** \![lock,balloonrepaint]。解くまで、書いたものを見せない */
  lockRepaint(): void {
    this.repaintLocked = true;
    this.span = undefined;
  }

  unlockRepaint(): void {
    this.repaintLocked = false;
    this.span = undefined;
    for (const el of this.text.querySelectorAll('.pending')) el.classList.remove('pending');
    this.scrollToEnd();
  }

  private markPending(el: HTMLElement): void {
    if (this.repaintLocked) el.classList.add('pending');
  }

  /** クリック待ち (\x) の間はクリック待ちのマーカーを出す */
  setWaitingClick(on: boolean): void {
    this.waitingClick = on;
    this.drawDecor();
  }

  /** SSTP で受けたスクリプトのマーカーとメッセージ (送り主など)。message が undefined なら消す */
  setSstp(message: string | undefined): void {
    this.sstp = message === undefined ? undefined : { marker: true, message };
    this.drawDecor();
  }

  /** オンラインマーカー (\![enter,onlinemode]) */
  setOnline(on: boolean): void {
    this.online = on;
    clearInterval(this.onlineTimer);
    this.onlineTimer = undefined;
    if (on) {
      const interval = Math.max(50, Number(this.skin.descript.get('onlinemarker.interval')) || 500);
      this.onlineTimer = window.setInterval(() => {
        this.onlineFrame++;
        this.drawDecor();
      }, interval);
    }
    this.drawDecor();
  }

  /** 受信中のファイルの数など (\![set,balloonnum,名前,今,最大])。すべて空なら消す */
  setNumber(name: string, current: string, max: string): void {
    this.number = name || current || max ? { name, current, max } : undefined;
    this.drawDecor();
  }

  // ---------------------------------------------------------------- 内部

  private newLine(): void {
    this.line = document.createElement('div');
    this.line.className = 'balloon-line';
    this.block.appendChild(this.line);
    this.span = undefined;
  }

  private lineHeight(): number {
    return parseFloat(getComputedStyle(this.text).lineHeight) || 18;
  }

  private cursor(): { x: number; y: number } {
    const marker = document.createElement('span');
    (this.link ?? this.line).appendChild(marker);
    const base = this.text.getBoundingClientRect();
    const r = marker.getBoundingClientRect();
    marker.remove();
    return {
      x: (r.left - base.left) / this.scale,
      y: (r.top - base.top) / this.scale + this.text.scrollTop,
    };
  }

  private scrollToEnd(): void {
    if (this.autoScroll && !this.repaintLocked) this.text.scrollTop = this.text.scrollHeight;
    this.updateArrows();
  }

  private textOrigin(): { left: number; top: number } {
    const [w, h] = this.skin.size(this.kind, this.balloonId, this.rightSide);
    const r = this.skin.textRect(this.kind, this.balloonId, this.rightSide, w, h);
    return { left: r.left, top: r.top };
  }

  private partElement(img: Bitmap): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c;
  }

  /** スクロールできる方向に矢印 (arrow0 / arrow1) を出す */
  private updateArrows(): void {
    if (!this.skin) return;
    this.drawDecor();
  }

  /** 矢印・マーカー・番号など、文字の上に重ねる部品を描き直す */
  private drawDecor(): void {
    if (!this.skin) return;
    // 固定の \_b 画像は残し、ほかは描き直す
    for (const el of [...this.decor.children]) if (!el.classList.contains('balloon-image-fixed')) el.remove();
    const [w, h] = this.skin.size(this.kind, this.balloonId, this.rightSide);
    const point = (prefix: string) => this.skin.partPoint(this.kind, this.balloonId, this.rightSide, prefix, w, h);
    /** 画像が無いバルーン (内蔵バルーンなど) では、代わりに文字の印を fallback の位置に出す */
    const put = (img: Bitmap | undefined, at: { x: number; y: number } | undefined, cls: string, glyph?: { text: string; x: number; y: number }) => {
      if (!img || !at) {
        if (!glyph) return;
        const g = document.createElement('div');
        g.className = `balloon-glyph ${cls}`;
        g.textContent = glyph.text;
        g.style.left = `${glyph.x}px`;
        g.style.top = `${glyph.y}px`;
        this.decor.appendChild(g);
        return;
      }
      const el = this.partElement(img);
      el.className = `balloon-part ${cls}`;
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y}px`;
      this.decor.appendChild(el);
    };
    const t = this.text;
    const canUp = t.scrollTop > 0;
    const canDown = t.scrollTop + t.clientHeight < t.scrollHeight - 1;
    if (canUp) put(this.skin.partImage(this.kind, 'arrow.filename', 'arrow', '0'), point('arrow0'), 'balloon-arrow', { text: '▲', x: w - 22, y: 2 });
    if (canDown) put(this.skin.partImage(this.kind, 'arrow.filename', 'arrow', '1'), point('arrow1'), 'balloon-arrow', { text: '▼', x: w - 22, y: h - 20 });
    if (this.waitingClick && !(canDown && !point('clickwaitmarker'))) {
      const img = this.skin.partImage(this.kind, 'clickwaitmarker.filename', 'clickwait');
      put(img, point('clickwaitmarker') ?? point('arrow1'), 'balloon-clickwait', { text: '▼', x: w - 22, y: h - 20 });
    }
    if (this.online) {
      const base = 'onlinemarker.filename';
      const frames: Bitmap[] = [];
      for (let i = 0; i < 64; i++) {
        const f = this.skin.partImage(this.kind, base, 'online', String(i));
        if (!f) break;
        frames.push(f);
      }
      put(frames[this.onlineFrame % Math.max(1, frames.length)], point('onlinemarker'), 'balloon-online', { text: '◐◓◑◒'[this.onlineFrame % 4], x: 8, y: 2 });
    }
    if (this.sstp) {
      put(this.skin.partImage(this.kind, 'sstpmarker.filename', 'sstp'), point('sstpmarker'), 'balloon-sstp-marker', { text: '✉', x: 8, y: 0 });
      const at = point('sstpmessage') ?? (point('sstpmarker') ? undefined : { x: 24, y: 1 });
      if (this.sstp.message && at) {
        const right = this.skin.partEdge(this.kind, this.balloonId, this.rightSide, 'sstpmessage.xr', w) ?? w - 8;
        const msg = document.createElement('div');
        msg.className = 'balloon-sstp-message';
        msg.textContent = this.sstp.message;
        msg.style.left = `${at.x}px`;
        msg.style.top = `${at.y}px`;
        msg.style.width = `${Math.max(0, right - at.x)}px`;
        this.decor.appendChild(msg);
      }
    }
    if (this.number) {
      const right = this.skin.partEdge(this.kind, this.balloonId, this.rightSide, 'number.xr', w) ?? this.skin.partEdge(this.kind, this.balloonId, this.rightSide, 'number.x', w);
      const top = this.skin.partEdge(this.kind, this.balloonId, this.rightSide, 'number.y', h);
      const num = document.createElement('div');
      num.className = 'balloon-number';
      const { name, current, max } = this.number;
      num.textContent = [name, current && max ? `${current}/${max}` : current || max].filter(Boolean).join(' ');
      num.style.right = `${w - (right ?? w - 8)}px`;
      num.style.top = `${top ?? 4}px`;
      this.decor.appendChild(num);
    }
  }

  private redraw(): void {
    if (!this.skin) return;
    const [w, h] = this.skin.size(this.kind, this.balloonId, this.rightSide);
    const img = this.skin.image(this.kind, this.balloonId, this.rightSide);
    this.inner.classList.toggle('builtin', !img);
    this.el.dataset.side = this.rightSide ? 'right' : 'left';
    this.bg.hidden = !img;
    if (img) {
      this.bg.width = img.width;
      this.bg.height = img.height;
      const ctx = this.bg.getContext('2d')!;
      ctx.clearRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
    }
    this.inner.style.width = `${w}px`;
    this.inner.style.height = `${h}px`;
    this.inner.style.transform = `scale(${this.scale})`;
    this.el.style.width = `${w * this.scale}px`;
    this.el.style.height = `${h * this.scale}px`;
    this.applyStyle();
    const r = this.skin.textRect(this.kind, this.balloonId, this.rightSide, w, h);
    const t = this.text.style;
    t.left = `${r.left}px`;
    t.top = `${r.top}px`;
    t.width = `${Math.max(0, r.right - r.left)}px`;
    t.height = `${Math.max(0, r.bottom - r.top)}px`;
    this.drawDecor();
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.redraw();
  }

  /** バルーンの背景をドラッグして動かす (選択肢・アンカーの上からは始めない) */
  private bindDrag(): void {
    let start: { x: number; y: number; ox: number; oy: number; id: number } | undefined;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.dragLocked || (e.target as HTMLElement).closest('.choice, .anchor')) return;
      start = { x: e.clientX, y: e.clientY, ox: this.userOffset.x, oy: this.userOffset.y, id: e.pointerId };
      this.dragged = false;
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!this.dragged) this.el.setPointerCapture?.(e.pointerId);
      this.dragged = true;
      this.userOffset.x = start.ox + dx;
      this.userOffset.y = start.oy + dy;
      this.applyPosition();
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      start = undefined;
      if (this.dragged) this.onMoved?.();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  destroy(): void {
    clearInterval(this.onlineTimer);
    this.el.remove();
  }
}

