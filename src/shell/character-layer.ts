import type { CharacterView, PointerInput } from './character-view';

/** 長押しでメニューを開くまでの時間 (タッチには右クリックが無いので) */
const LONG_PRESS_MS = 500;
/** 長押し・ダブルタップとみなす指のずれ (px) */
const TOUCH_SLOP = 10;
const DOUBLE_TAP_MS = 400;

/**
 * デスクトップ上のキャラクターへのマウス・タッチ入力をまとめて振り分ける。
 * 各キャラクターの canvas は矩形なので、上にあるキャラクターの透明な部分が下のキャラクターを
 * 隠してしまう。ここで上から順に「そのピクセルが不透明なキャラクター」を探して渡す (SSP のウィンドウ同様)。
 *
 * キャラクターはページ (README の文書) の上に重なる。デスクトップの層は入力を通すので、文書全体で受けて、
 * キャラクターに当たった入力だけを横取りする (それ以外はスクロール・文字の選択・リンクとしてページに届く)。
 * Pointer Events の無いブラウザ (Safari 12 など) では、マウスとタッチの event から同じ入力を作る。
 * タッチでは、長押しが右クリック、2回続けてのタップがダブルクリックになる。
 */
export class CharacterLayer {
  private readonly views: CharacterView[] = [];
  private active?: { view: CharacterView; pointerId: number };
  private hovered?: CharacterView;
  private longPress?: { timer: number; x: number; y: number };
  /** 長押しでメニューを開いた時刻 (続けて届くブラウザの contextmenu を無視するため) */
  private longPressAt = 0;
  private lastTap?: { view: CharacterView; x: number; y: number; at: number };
  /** 右ドラッグのジェスチャー中のキャラクター */
  private gesturing?: { view: CharacterView; pointerId: number };
  /** ジェスチャーを終えた時刻 (続いて来る contextmenu でメニューを出さない) */
  private gestureAt = 0;
  /** 最後にタッチで触った時刻 (タッチから作られた dblclick を二重に扱わないため) */
  private touchedAt = 0;

  constructor(
    readonly desktop: HTMLElement,
    /** バルーンの上での右クリック (キャラクターの無い所ではブラウザのメニューのまま) */
    private readonly onBalloonContextMenu: (e: MouseEvent) => void,
  ) {
    this.bind();
  }

  add(view: CharacterView): void {
    this.views.push(view);
  }

  remove(view: CharacterView): void {
    const i = this.views.indexOf(view);
    if (i >= 0) this.views.splice(i, 1);
    if (this.hovered === view) this.hovered = undefined;
    if (this.active?.view === view) this.active = undefined;
    if (this.lastTap?.view === view) this.lastTap = undefined;
  }

  /**
   * ページかデスクトップに向いた入力か。除くもの (バルーン、メニュー・タスクバー・通知の .overlay、ダイアログと
   * dialog-polyfill の背景) を挙げ、それ以外はすべてキャラクターに届けうる
   * (広い画面では、本文の列の外にいるキャラクターの下は <main> や <body> になる)。
   */
  private onDesktop(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.balloon, .overlay, .select-overlay, dialog, .backdrop, ._dialog_overlay') === null;
  }

  /** その位置で一番上にある、不透明なピクセルを持つキャラクター */
  private pick(e: { clientX: number; clientY: number; target: EventTarget | null }): CharacterView | undefined {
    const dragging = this.active?.view;
    if (dragging?.hit(e.clientX, e.clientY)) return dragging;
    if (!this.onDesktop(e.target)) return undefined;
    // 後から追加したものほど上に描かれる
    for (let i = this.views.length - 1; i >= 0; i--) {
      if (this.views[i].hit(e.clientX, e.clientY)) return this.views[i];
    }
    return undefined;
  }

  private setHovered(view: CharacterView | undefined, e: PointerInput): void {
    if (view === this.hovered) return;
    this.hovered?.leave(e);
    this.hovered = view;
    view?.enter(e);
    document.documentElement.classList.toggle('over-character', view !== undefined);
  }

  // ---------------------------------------------------------------- 入力の種類によらない処理

  /** キャラクターに当たったら受け取る (true)。当たらなければページに任せる */
  private down(input: PointerInput, ev: Event, capture?: () => void): boolean {
    const view = this.pick(input);
    if (!view) return false;
    // ページの文字の選択やフォーカスの移動、タッチのスクロールを始めさせない (フォーカスはページから外す)
    ev.preventDefault();
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.page')) document.activeElement.blur();
    view.pointerDown(input);
    if (input.button === 2) this.gesturing = { view, pointerId: input.pointerId };
    if (input.pointerType === 'touch') {
      this.touchedAt = Date.now();
      this.startLongPress(view, input);
    }
    if (input.button === 0) {
      this.active = { view, pointerId: input.pointerId };
      capture?.();
    }
    return true;
  }

  private move(input: PointerInput): void {
    if (this.longPress && Math.hypot(input.clientX - this.longPress.x, input.clientY - this.longPress.y) > TOUCH_SLOP) this.cancelLongPress();
    if (this.gesturing && this.gesturing.pointerId === input.pointerId) this.gesturing.view.gestureMove(input);
    if (this.active && this.active.pointerId === input.pointerId) {
      this.active.view.dragMove(input);
      return;
    }
    if (input.pointerType === 'touch') return;
    const view = this.pick(input);
    this.setHovered(view, input);
    view?.hoverMove(input);
  }

  /** ドラッグ (押している間) を終える。押していたものでなければ false */
  private end(input: PointerInput, cancelled: boolean, release?: () => void): boolean {
    this.cancelLongPress();
    const a = this.active;
    if (!a || a.pointerId !== input.pointerId) return false;
    this.active = undefined;
    release?.();
    const tapped = !cancelled && !a.view.dragged;
    a.view.pointerUp(input, cancelled);
    if (tapped && input.pointerType === 'touch') this.tap(a.view, input);
    return true;
  }

  /** 右ボタンを放した。ジェスチャーだったら、続く contextmenu を出さない */
  private endGesture(e: { clientX: number; clientY: number; button: number }): void {
    const g = this.gesturing;
    this.gesturing = undefined;
    if (g?.view.gestureEnd(e)) this.gestureAt = Date.now();
  }

  /** 2回目のタップならダブルクリック */
  private tap(view: CharacterView, input: PointerInput): void {
    const prev = this.lastTap;
    const now = Date.now();
    if (prev && prev.view === view && now - prev.at < DOUBLE_TAP_MS && Math.hypot(input.clientX - prev.x, input.clientY - prev.y) < TOUCH_SLOP * 2) {
      this.lastTap = undefined;
      view.doubleClick(input);
      return;
    }
    this.lastTap = { view, x: input.clientX, y: input.clientY, at: now };
  }

  private startLongPress(view: CharacterView, input: PointerInput): void {
    this.cancelLongPress();
    const timer = window.setTimeout(() => {
      this.longPress = undefined;
      this.longPressAt = Date.now();
      // ドラッグをやめてからメニューにする
      if (this.active?.view === view) {
        this.active = undefined;
        view.pointerUp(input, true);
      }
      this.lastTap = undefined;
      view.contextMenu(input);
    }, LONG_PRESS_MS);
    this.longPress = { timer, x: input.clientX, y: input.clientY };
  }

  private cancelLongPress(): void {
    if (!this.longPress) return;
    clearTimeout(this.longPress.timer);
    this.longPress = undefined;
  }

  // ---------------------------------------------------------------- event の受け口

  private bind(): void {
    if (typeof PointerEvent === 'function') this.bindPointerEvents();
    else this.bindMouseAndTouch();

    // キャラクターの下にあるリンクなどを押したことにしない
    document.addEventListener(
      'click',
      (e) => {
        if (this.pick(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    document.addEventListener('dblclick', (e) => {
      // タッチのダブルタップは tap() で扱っている
      if (Date.now() - this.touchedAt < 1000) return;
      this.pick(e)?.doubleClick(e);
    });

    document.addEventListener('contextmenu', (e) => {
      if (e.target instanceof Element && e.target.closest('.desktop .balloon')) {
        e.preventDefault();
        this.onBalloonContextMenu(e);
        return;
      }
      // 長押しで既に開いた (Android などはこの後にブラウザの contextmenu も来る)。右ドラッグのジェスチャーの後も出さない
      if (Date.now() - this.longPressAt < 1000 || Date.now() - this.gestureAt < 500) {
        e.preventDefault();
        return;
      }
      const view = this.pick(e);
      if (!view) return;
      e.preventDefault();
      this.cancelLongPress();
      this.longPressAt = Date.now();
      view.contextMenu(e);
    });

    document.addEventListener(
      'wheel',
      (e) => {
        const view = this.pick(e);
        if (!view) return;
        e.preventDefault();
        view.wheel(e);
      },
      { passive: false },
    );
  }

  private bindPointerEvents(): void {
    const root = document.documentElement;
    document.addEventListener('pointerdown', (e) => {
      this.down(e, e, () => root.setPointerCapture(e.pointerId));
    });
    // タッチでキャラクターをドラッグするとき、ページをスクロールさせない
    document.addEventListener(
      'touchstart',
      (e) => {
        const t = e.changedTouches[0];
        if (!t || !this.onDesktop(e.target)) return;
        if (this.views.some((v) => v.hit(t.clientX, t.clientY))) e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener('pointermove', (e) => this.move(e));
    const release = (e: PointerEvent) => () => {
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    };
    document.addEventListener('pointerup', (e) => {
      if (e.button === 2) this.endGesture(e);
      if (this.end(e, false, release(e))) return;
      // 中ボタン・戻る・進むのボタン (左はドラッグ扱いで上の end に、右は contextmenu に来る)
      if (e.button === 1 || e.button === 3 || e.button === 4) this.pick(e)?.exUp(e);
    });
    document.addEventListener('pointercancel', (e) => void this.end(e, true, release(e)));
    root.addEventListener('pointerleave', (e) => {
      if (!this.active) this.setHovered(undefined, e);
    });
  }

  /** Pointer Events の無いブラウザ用。タッチを preventDefault すると、後から来る互換のマウス event も止まる */
  private bindMouseAndTouch(): void {
    const mouse = (e: MouseEvent): PointerInput => ({
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      pointerId: 1,
      pointerType: 'mouse',
      target: e.target,
    });
    const touch = (e: TouchEvent, t: Touch): PointerInput => ({
      clientX: t.clientX,
      clientY: t.clientY,
      button: 0,
      pointerId: t.identifier + 2,
      pointerType: 'touch',
      target: e.target,
    });
    const tracked = (e: TouchEvent) => Array.from(e.changedTouches).find((t) => this.active?.pointerId === t.identifier + 2);

    document.addEventListener('mousedown', (e) => void this.down(mouse(e), e));
    document.addEventListener('mousemove', (e) => this.move(mouse(e)));
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.endGesture(e);
      if (this.end(mouse(e), false)) return;
      if (e.button === 1 || e.button === 3 || e.button === 4) this.pick(e)?.exUp(e);
    });
    document.documentElement.addEventListener('mouseleave', (e) => {
      if (!this.active) this.setHovered(undefined, mouse(e));
    });

    document.addEventListener(
      'touchstart',
      (e) => {
        if (this.active) return;
        const t = e.changedTouches[0];
        if (t) this.down(touch(e, t), e);
      },
      { passive: false },
    );
    document.addEventListener(
      'touchmove',
      (e) => {
        const t = tracked(e);
        if (!t) return;
        e.preventDefault();
        this.move(touch(e, t));
      },
      { passive: false },
    );
    document.addEventListener('touchend', (e) => {
      const t = tracked(e);
      if (t) this.end(touch(e, t), false);
      else this.cancelLongPress();
    });
    document.addEventListener('touchcancel', (e) => {
      const t = tracked(e);
      if (t) this.end(touch(e, t), true);
      else this.cancelLongPress();
    });
  }
}
