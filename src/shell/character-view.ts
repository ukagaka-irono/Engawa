import type { CharacterLayer } from './character-layer';
import type { SurfaceRenderer } from './renderer';

/** 位置とボタンが分かれば足りるマウス・タッチの入力 (MouseEvent / PointerEvent、またはそれらから作ったもの) */
export type MouseLike = Pick<MouseEvent, 'clientX' | 'clientY' | 'button'> & { pointerType?: string };

/** CharacterLayer が渡す入力。Pointer Events の無いブラウザではマウス・タッチの event から作る */
export interface PointerInput extends MouseLike {
  pointerId: number;
  /** 'mouse' | 'touch' | 'pen' */
  pointerType: string;
  target: EventTarget | null;
}

export type MouseButton = 0 | 1 | 2; // SHIORI の Reference5: 0 左, 1 右, 2 中

export interface CharacterMouseEvent {
  scope: number;
  /** サーフェス座標 (拡大率を戻した値) */
  x: number;
  y: number;
  collision: string;
  button: MouseButton;
  wheel: number;
  clientX: number;
  clientY: number;
  /** Reference6 (mouse / touch / pen) */
  device: string;
  /** 続けてクリックした回数 (1 から) */
  clicks: number;
}

export interface CharacterViewHandlers {
  click(e: CharacterMouseEvent): void;
  doubleClick(e: CharacterMouseEvent): void;
  move(e: CharacterMouseEvent): void;
  wheel(e: CharacterMouseEvent): void;
  enter(e: CharacterMouseEvent): void;
  leave(e: CharacterMouseEvent): void;
  contextMenu(e: CharacterMouseEvent): void;
  /** 左ボタンを押した (OnMouseDown) */
  mouseDown(e: CharacterMouseEvent): void;
  /** 左ボタンを放した (OnMouseUp)。clicked ならドラッグせずに放した (クリック) */
  mouseUp(e: CharacterMouseEvent, clicked: boolean): void;
  /** ドラッグを始めた・終えた */
  dragStart(e: CharacterMouseEvent): void;
  dragEnd(e: CharacterMouseEvent): void;
  /** マウスが止まっている (OnMouseHover) */
  hover(e: CharacterMouseEvent): void;
  /** ドラッグで位置が変わった (確定時) */
  moved(): void;
  /** 位置・大きさが変わった (バルーンの追従用)。ドラッグの途中は dragging */
  layout(dragging: boolean): void;
  /** ドラッグで動いた量 (いっしょに動くキャラクター用、sticky-window) */
  dragged(dx: number, dy: number): void;
  pointerDown(): void;
}

/** デスクトップのどの端に吸着するか (alignmenttodesktop) */
export type Alignment = 'bottom' | 'top' | 'left' | 'right' | 'free';

const DRAG_THRESHOLD = 4;
const MOVE_THROTTLE_MS = 50;
const HOVER_MS = 600;
const MULTI_CLICK_MS = 450;

function toButton(b: number): MouseButton {
  return b === 2 ? 1 : b === 1 ? 2 : 0;
}

/**
 * 1キャラクターの DOM。デスクトップ上の位置は「右端からの距離」と「下端からの距離」で持つ。
 * SSP と同じく画面右下を基準にし、ウィンドウの大きさが変わっても位置を保つ。
 * 入力は CharacterLayer が透明部分を考慮して振り分け、ここのメソッドを呼ぶ。
 */
export class CharacterView {
  readonly el = document.createElement('div');
  /** キャラクター中心の、デスクトップ右端からの距離 */
  right = 0;
  /** キャラクター下端の、デスクトップ下端からの距離 */
  bottom = 0;
  placed = false;
  /** 全体の拡大率 (オプション) */
  scale = 1;
  /** このキャラクターだけの倍率 (\![set,scaling]。負の数は反転) */
  scaleX = 1;
  scaleY = 1;
  alignment: Alignment = 'bottom';
  /** ドラッグで動かせない (\![set,position]) */
  pinned = false;

  private lastMove = 0;
  private drag?: { x: number; y: number; right: number; bottom: number; moved: boolean; last: { x: number; y: number } };
  private readonly desktop: HTMLElement;
  private hoverTimer?: number;
  private lastClick?: { at: number; count: number };
  private moveAnim?: number;

  constructor(
    readonly scope: number,
    readonly renderer: SurfaceRenderer,
    private readonly layer: CharacterLayer,
    private readonly on: CharacterViewHandlers,
  ) {
    this.desktop = layer.desktop;
    this.el.className = 'character';
    this.el.dataset.scope = String(scope);
    this.el.appendChild(renderer.canvas);
    this.desktop.appendChild(this.el);
    renderer.onResize = () => this.layout();
    layer.add(this);
  }

  /** 実際の倍率 (全体 × このキャラクター) */
  get zoomX(): number {
    return this.scale * Math.abs(this.scaleX);
  }

  get zoomY(): number {
    return this.scale * Math.abs(this.scaleY);
  }

  get width(): number {
    return this.renderer.canvas.width * this.zoomX;
  }

  get height(): number {
    return this.renderer.canvas.height * this.zoomY;
  }

  /** デスクトップ座標での矩形 */
  rect(): { left: number; top: number; width: number; height: number } {
    const dw = this.desktop.clientWidth;
    const dh = this.desktop.clientHeight;
    const left = dw - this.right - this.width / 2;
    const top = dh - this.bottom - this.height;
    return { left, top, width: this.width, height: this.height };
  }

  setCenter(left: number, bottomY: number): void {
    this.right = this.desktop.clientWidth - left;
    this.bottom = Math.max(0, this.desktop.clientHeight - bottomY);
    this.placed = true;
    this.layout();
  }

  /** 左上をデスクトップ座標 (left, top) に置く */
  setTopLeft(left: number, top: number): void {
    this.right = this.desktop.clientWidth - left - this.width / 2;
    this.bottom = this.desktop.clientHeight - top - this.height;
    this.placed = true;
    this.applyAlignment();
    this.layout();
  }

  /** 吸着している端に合わせる */
  applyAlignment(): void {
    const dw = this.desktop.clientWidth;
    const dh = this.desktop.clientHeight;
    if (this.alignment === 'bottom') this.bottom = 0;
    else if (this.alignment === 'top') this.bottom = Math.max(0, dh - this.height);
    else if (this.alignment === 'left') this.right = dw - this.width / 2;
    else if (this.alignment === 'right') this.right = this.width / 2;
  }

  /** time ms かけて左上を (left, top) へ動かす。0 なら すぐ。止められたら false */
  animateTo(left: number, top: number, time: number, signal?: { cancelled: boolean }): Promise<boolean> {
    cancelAnimationFrame(this.moveAnim ?? 0);
    const from = this.rect();
    if (time <= 0) {
      this.setTopLeft(left, top);
      this.on.moved();
      return Promise.resolve(true);
    }
    const start = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const end = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelAnimationFrame(this.moveAnim ?? 0);
        if (ok) this.setTopLeft(left, top);
        this.on.moved();
        resolve(ok);
      };
      // 見えていないタブでは rAF が止まるので、時間が来たら行き先に置く (\![move] のスクリプトを止めたままにしない)
      const timer = window.setTimeout(() => end(!signal?.cancelled), time + 100);
      const step = (now: number) => {
        if (done) return;
        if (signal?.cancelled) return end(false);
        const t = Math.min(1, (now - start) / time);
        if (t >= 1) return end(true);
        this.setTopLeft(from.left + (left - from.left) * t, from.top + (top - from.top) * t);
        this.moveAnim = requestAnimationFrame(step);
      };
      this.moveAnim = requestAnimationFrame(step);
    });
  }

  layout(dragging = false): void {
    const visible = this.renderer.visible;
    this.el.hidden = !visible;
    if (!visible) {
      this.on.layout(dragging);
      return;
    }
    const r = this.rect();
    this.el.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`;
    this.el.style.width = `${r.width}px`;
    this.el.style.height = `${r.height}px`;
    const c = this.renderer.canvas.style;
    c.width = `${r.width}px`;
    c.height = `${r.height}px`;
    c.transform = this.scaleX < 0 || this.scaleY < 0 ? `scale(${this.scaleX < 0 ? -1 : 1}, ${this.scaleY < 0 ? -1 : 1})` : '';
    this.on.layout(dragging);
  }

  /** デスクトップからはみ出したら押し戻す (2割は画面に残す) */
  clamp(): void {
    const dw = this.desktop.clientWidth;
    const half = this.width / 2;
    this.right = Math.min(Math.max(this.right, half - this.width * 0.8), dw - half + this.width * 0.8);
    this.bottom = Math.min(Math.max(this.bottom, 0), Math.max(0, this.desktop.clientHeight - this.height * 0.2));
    this.applyAlignment();
  }

  destroy(): void {
    clearTimeout(this.hoverTimer);
    cancelAnimationFrame(this.moveAnim ?? 0);
    this.layer.remove(this);
    this.el.remove();
  }

  /** クライアント座標をサーフェス座標にする (反転・倍率を戻す) */
  private local(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.renderer.canvas.getBoundingClientRect();
    let x = (clientX - box.left) / this.zoomX;
    let y = (clientY - box.top) / this.zoomY;
    if (this.scaleX < 0) x = this.renderer.canvas.width - x;
    if (this.scaleY < 0) y = this.renderer.canvas.height - y;
    return { x, y };
  }

  /** クライアント座標がこのキャラクターの不透明なピクセルに当たるか (見えない・透明にしたものは当たらない) */
  hit(clientX: number, clientY: number): boolean {
    if (this.el.hidden || !this.renderer.visible || this.el.style.opacity === '0') return false;
    const { x, y } = this.local(clientX, clientY);
    return this.renderer.opaqueAt(x, y);
  }

  private event(e: MouseLike, wheel = 0, clicks = 1): CharacterMouseEvent {
    const { x, y } = this.local(e.clientX, e.clientY);
    return {
      scope: this.scope,
      x: Math.floor(x),
      y: Math.floor(y),
      collision: this.renderer.collisionAt(x, y)?.name ?? '',
      button: toButton(e.button),
      wheel,
      clientX: e.clientX,
      clientY: e.clientY,
      device: e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse',
      clicks,
    };
  }

  // ---------------------------------------------------------------- CharacterLayer から呼ばれる

  /** 押している間に、ドラッグとみなすほど動かしたか */
  get dragged(): boolean {
    return this.drag?.moved ?? false;
  }

  pointerDown(e: PointerInput): void {
    this.on.pointerDown();
    clearTimeout(this.hoverTimer);
    if (e.button === 0) {
      this.drag = { x: e.clientX, y: e.clientY, right: this.right, bottom: this.bottom, moved: false, last: { x: e.clientX, y: e.clientY } };
      this.on.mouseDown(this.event(e));
    }
  }

  dragMove(e: PointerInput): void {
    const drag = this.drag;
    if (!drag || this.pinned) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) this.on.dragStart(this.event(e));
    drag.moved = true;
    this.el.classList.add('dragging');
    const before = { right: this.right, bottom: this.bottom };
    const horizontal = this.alignment !== 'left' && this.alignment !== 'right';
    const vertical = this.alignment === 'free' || this.alignment === 'left' || this.alignment === 'right';
    if (horizontal) this.right = drag.right - dx;
    if (vertical) this.bottom = Math.max(0, drag.bottom - dy);
    this.layout(true);
    this.on.dragged(before.right - this.right, this.bottom - before.bottom);
  }

  /** ドラッグせずに離したらクリック */
  pointerUp(e: PointerInput, cancelled: boolean): void {
    const drag = this.drag;
    this.drag = undefined;
    this.el.classList.remove('dragging');
    if (drag?.moved) {
      this.clamp();
      this.layout();
      this.on.dragEnd(this.event(e));
      this.on.moved();
      return;
    }
    if (cancelled) return;
    const clicked = this.hit(e.clientX, e.clientY);
    this.on.mouseUp(this.event(e, 0, clicked ? this.countClick() : 1), clicked);
  }

  /** 続けてクリックした回数を数える */
  private countClick(): number {
    const now = performance.now();
    const count = this.lastClick && now - this.lastClick.at < MULTI_CLICK_MS ? this.lastClick.count + 1 : 1;
    this.lastClick = { at: now, count };
    return count;
  }

  click(e: MouseLike): void {
    this.on.click(this.event(e));
  }

  hoverMove(e: PointerInput): void {
    clearTimeout(this.hoverTimer);
    const ev = this.event(e);
    this.hoverTimer = window.setTimeout(() => this.on.hover(ev), HOVER_MS);
    const now = performance.now();
    if (now - this.lastMove < MOVE_THROTTLE_MS) return;
    this.lastMove = now;
    this.on.move(ev);
  }

  enter(e: PointerInput): void {
    this.on.enter(this.event(e));
  }

  leave(e: PointerInput): void {
    clearTimeout(this.hoverTimer);
    this.on.leave(this.event(e));
  }

  doubleClick(e: MouseLike): void {
    this.on.doubleClick(this.event(e));
  }

  contextMenu(e: MouseLike): void {
    const ev = this.event(e);
    ev.button = 1;
    this.on.click(ev);
    this.on.contextMenu(ev);
  }

  wheel(e: WheelEvent): void {
    this.on.wheel(this.event(e, e.deltaY < 0 ? 120 : -120));
  }
}
