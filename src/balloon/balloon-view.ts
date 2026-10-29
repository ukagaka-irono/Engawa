import type { BalloonKind, BalloonSkin } from './skin';

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
}

function fontKey(f: FontState): string {
  return JSON.stringify(f);
}

function applyFont(el: HTMLElement, f: FontState): void {
  const s = el.style;
  if (f.color) s.color = f.color;
  if (f.size) s.fontSize = `${f.size}px`;
  if (f.bold !== undefined) s.fontWeight = f.bold ? 'bold' : 'normal';
  if (f.italic) s.fontStyle = 'italic';
  const deco = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) s.textDecoration = deco;
  if (f.family) s.fontFamily = `"${f.family.replace(/"/g, '')}", var(--font-balloon)`;
  if (f.sub) s.verticalAlign = 'sub';
  if (f.sup) s.verticalAlign = 'super';
  if (f.sub || f.sup) s.fontSize = '0.75em';
}

/** 1つのバルーン (scope ごとに1つ)。テキストは DOM で組む。 */
export class BalloonView {
  readonly el = document.createElement('div');
  balloonId = 0;
  rightSide = false;
  shown = false;
  scale = 1;
  onClick?: () => void;

  private readonly inner = document.createElement('div');
  private readonly bg = document.createElement('canvas');
  private readonly text = document.createElement('div');
  private block!: HTMLElement;
  private line!: HTMLElement;
  private span?: HTMLSpanElement;
  private spanKey = '';
  private link?: HTMLElement;
  private skin!: BalloonSkin;
  private chars = 0;

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
    this.inner.append(this.bg, this.text);
    this.el.appendChild(this.inner);
    desktop.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.choice, .anchor')) return;
      this.onClick?.();
    });
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
    s.setProperty('--b-color', st.color);
    s.setProperty('--b-anchor', st.anchorColor);
    s.setProperty('--b-cursor-bg', st.cursorBackground);
    s.setProperty('--b-cursor-color', st.cursorColor);
    this.el.dataset.cursor = st.cursorStyle;
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
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  show(): void {
    this.shown = true;
    this.el.hidden = false;
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
  }

  write(str: string, font: FontState): void {
    const key = fontKey(font);
    const parent = this.link ?? this.line;
    if (!this.span || this.spanKey !== key || this.span.parentElement !== parent) {
      this.span = document.createElement('span');
      applyFont(this.span, font);
      parent.appendChild(this.span);
      this.spanKey = key;
    }
    this.span.append(str);
    this.chars += str.length;
    this.scrollToEnd();
  }

  /** \n。ratio は \n[half] や \n[150] の行送り量 (1 = 1行、負の値は上へ戻る)。 */
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

  /** \q[title,id] (1つの選択肢を一度に置く) */
  choice(title: string, font: FontState, onSelect: () => void): void {
    this.beginLink('choice', onSelect);
    this.write(title, font);
    this.endLink();
  }

  /** \__q / \_a の開始。以降の write はこの中に入る。 */
  beginLink(kind: 'choice' | 'anchor', onSelect: () => void): void {
    this.endLink();
    const a = document.createElement('a');
    a.className = kind;
    a.tabIndex = 0;
    a.setAttribute('role', 'button');
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect();
    });
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    });
    this.line.appendChild(a);
    this.link = a;
    this.span = undefined;
  }

  endLink(): void {
    if (!this.link) return;
    this.link = undefined;
    this.span = undefined;
  }

  /** \_l[x,y]。数値は文字領域の左上からの px、`@` 付きは現在位置からの相対。 */
  locate(xArg: string | undefined, yArg: string | undefined): void {
    this.endLink();
    const cur = this.cursor();
    const resolve = (arg: string | undefined, current: number): number => {
      if (arg === undefined || arg.trim() === '') return current;
      const a = arg.trim();
      const rel = a.startsWith('@');
      const n = parseFloat(rel ? a.slice(1) : a);
      if (!Number.isFinite(n)) return current;
      const px = a.endsWith('em') ? n * this.lineHeight() : n;
      return rel ? current + px : px;
    };
    const x = resolve(xArg, cur.x);
    const y = resolve(yArg, cur.y);
    const block = document.createElement('div');
    block.className = 'balloon-block';
    block.style.left = `${x}px`;
    block.style.top = `${y}px`;
    block.style.width = `${Math.max(0, this.text.clientWidth - x)}px`;
    this.text.appendChild(block);
    this.block = block;
    this.newLine();
  }

  /**
   * \_b[file,inline] など。インラインか、文字領域内の座標に置く。
   * 座標指定の画像は文字の下に描く (foreground なら上)。
   */
  image(url: string, at?: { x: number; y: number; foreground: boolean }): void {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    if (!at) {
      img.className = 'balloon-inline-image';
      (this.link ?? this.line).appendChild(img);
      this.span = undefined;
    } else {
      img.className = at.foreground ? 'balloon-image balloon-image-front' : 'balloon-image';
      img.style.left = `${at.x}px`;
      img.style.top = `${at.y}px`;
      this.text.appendChild(img);
    }
    this.scrollToEnd();
  }

  /** \c[char,n] */
  deleteChars(n: number): void {
    const walker = document.createTreeWalker(this.text, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let rest = n;
    for (let i = nodes.length - 1; i >= 0 && rest > 0; i--) {
      const t = nodes[i];
      const take = Math.min(rest, t.data.length);
      t.data = t.data.slice(0, t.data.length - take);
      rest -= take;
      this.chars -= take;
    }
  }

  /** \c[line,n] */
  deleteLines(n: number): void {
    const lines = [...this.text.querySelectorAll('.balloon-line')];
    lines.slice(Math.max(0, lines.length - n)).forEach((l) => l.remove());
    this.block = this.text;
    this.newLine();
  }

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
    this.text.scrollTop = this.text.scrollHeight;
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
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.redraw();
  }

  destroy(): void {
    this.el.remove();
  }
}
