import type { CharacterLayer } from './character-layer';
import type { SurfaceRenderer } from './renderer';

/** 位置とボタンが分かれば足りるマウス・タッチの入力 (MouseEvent / PointerEvent、またはそれらから作ったもの) */
export type MouseLike = Pick<MouseEvent, 'clientX' | 'clientY' | 'button'>;

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
}

export interface CharacterViewHandlers {
  click(e: CharacterMouseEvent): void;
  doubleClick(e: CharacterMouseEvent): void;
  move(e: CharacterMouseEvent): void;
  wheel(e: CharacterMouseEvent): void;
  enter(e: CharacterMouseEvent): void;
  leave(e: CharacterMouseEvent): void;
  contextMenu(e: CharacterMouseEvent): void;
  /** ドラッグで位置が変わった (確定時) */
  moved(): void;
  /** 位置・大きさが変わった (バルーンの追従用) */
  layout(): void;
  pointerDown(): void;
}

const DRAG_THRESHOLD = 4;
const MOVE_THROTTLE_MS = 50;

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
  scale = 1;
  freeMove = false;

  private lastMove = 0;
  private drag?: { x: number; y: number; right: number; bottom: number; moved: boolean };
  private readonly desktop: HTMLElement;

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

  get width(): number {
    return this.renderer.canvas.width * this.scale;
  }

  get height(): number {
    return this.renderer.canvas.height * this.scale;
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

  layout(): void {
    const visible = this.renderer.visible;
    this.el.hidden = !visible;
    if (!visible) {
      this.on.layout();
      return;
    }
    const r = this.rect();
    this.el.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`;
    this.el.style.width = `${r.width}px`;
    this.el.style.height = `${r.height}px`;
    this.renderer.canvas.style.width = `${r.width}px`;
    this.renderer.canvas.style.height = `${r.height}px`;
    this.on.layout();
  }

  /** デスクトップからはみ出したら押し戻す (2割は画面に残す) */
  clamp(): void {
    const dw = this.desktop.clientWidth;
    const half = this.width / 2;
    this.right = Math.min(Math.max(this.right, half - this.width * 0.8), dw - half + this.width * 0.8);
    this.bottom = Math.min(Math.max(this.bottom, 0), Math.max(0, this.desktop.clientHeight - this.height * 0.2));
  }

  destroy(): void {
    this.layer.remove(this);
    this.el.remove();
  }

  /** クライアント座標がこのキャラクターの不透明なピクセルに当たるか */
  hit(clientX: number, clientY: number): boolean {
    if (this.el.hidden || !this.renderer.visible) return false;
    const box = this.renderer.canvas.getBoundingClientRect();
    return this.renderer.opaqueAt((clientX - box.left) / this.scale, (clientY - box.top) / this.scale);
  }

  private event(e: MouseLike, wheel = 0): CharacterMouseEvent {
    const box = this.renderer.canvas.getBoundingClientRect();
    const x = (e.clientX - box.left) / this.scale;
    const y = (e.clientY - box.top) / this.scale;
    return {
      scope: this.scope,
      x: Math.floor(x),
      y: Math.floor(y),
      collision: this.renderer.collisionAt(x, y)?.name ?? '',
      button: toButton(e.button),
      wheel,
      clientX: e.clientX,
      clientY: e.clientY,
    };
  }

  // ---------------------------------------------------------------- CharacterLayer から呼ばれる

  /** 押している間に、ドラッグとみなすほど動かしたか */
  get dragged(): boolean {
    return this.drag?.moved ?? false;
  }

  pointerDown(e: PointerInput): void {
    this.on.pointerDown();
    if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, right: this.right, bottom: this.bottom, moved: false };
  }

  dragMove(e: PointerInput): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    this.el.classList.add('dragging');
    this.right = drag.right - dx;
    if (this.freeMove) this.bottom = Math.max(0, drag.bottom - dy);
    this.layout();
  }

  /** ドラッグせずに離したらクリック */
  pointerUp(e: PointerInput, cancelled: boolean): void {
    const drag = this.drag;
    this.drag = undefined;
    this.el.classList.remove('dragging');
    if (drag?.moved) {
      this.clamp();
      this.layout();
      this.on.moved();
      return;
    }
    if (!cancelled && this.hit(e.clientX, e.clientY)) this.click(e);
  }

  click(e: MouseLike): void {
    this.on.click(this.event(e));
  }

  hoverMove(e: PointerInput): void {
    const now = performance.now();
    if (now - this.lastMove < MOVE_THROTTLE_MS) return;
    this.lastMove = now;
    this.on.move(this.event(e));
  }

  enter(e: PointerInput): void {
    this.on.enter(this.event(e));
  }

  leave(e: PointerInput): void {
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
