import type { CharacterView } from './character-view';

/**
 * デスクトップ上のキャラクターへのマウス・タッチ入力をまとめて振り分ける。
 * 各キャラクターの canvas は矩形なので、上にあるキャラクターの透明な部分が下のキャラクターを
 * 隠してしまう。ここで上から順に「そのピクセルが不透明なキャラクター」を探して渡す (SSP のウィンドウ同様)。
 *
 * キャラクターはページ (README の文書) の上に重なる。デスクトップの層は入力を通すので、文書全体で受けて、
 * キャラクターに当たった入力だけを横取りする (それ以外はスクロール・文字の選択・リンクとしてページに届く)。
 */
export class CharacterLayer {
  private readonly views: CharacterView[] = [];
  private active?: { view: CharacterView; pointerId: number };
  private hovered?: CharacterView;

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
  }

  /** ページかデスクトップに向いた入力か (メニュー・ダイアログ・タスクバー・バルーンの上のものは除く) */
  private onDesktop(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || target.closest('.balloon')) return false;
    return target === document.documentElement || target === document.body || target.closest('.page, .desktop') !== null;
  }

  /** その位置で一番上にある、不透明なピクセルを持つキャラクター */
  private pick(e: MouseEvent): CharacterView | undefined {
    const dragging = this.active?.view;
    if (dragging?.hit(e.clientX, e.clientY)) return dragging;
    if (!this.onDesktop(e.target)) return undefined;
    // 後から追加したものほど上に描かれる
    for (let i = this.views.length - 1; i >= 0; i--) {
      if (this.views[i].hit(e.clientX, e.clientY)) return this.views[i];
    }
    return undefined;
  }

  private setHovered(view: CharacterView | undefined, e: PointerEvent): void {
    if (view === this.hovered) return;
    this.hovered?.leave(e);
    this.hovered = view;
    view?.enter(e);
    document.documentElement.classList.toggle('over-character', view !== undefined);
  }

  private bind(): void {
    const root = document.documentElement;
    document.addEventListener('pointerdown', (e) => {
      const view = this.pick(e);
      if (!view) return;
      // ページの文字の選択やフォーカスの移動を始めさせない (フォーカスはページから外す)
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.page')) document.activeElement.blur();
      view.pointerDown(e);
      if (e.button !== 0) return;
      this.active = { view, pointerId: e.pointerId };
      root.setPointerCapture(e.pointerId);
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

    document.addEventListener('pointermove', (e) => {
      if (this.active && this.active.pointerId === e.pointerId) {
        this.active.view.dragMove(e);
        return;
      }
      const view = this.pick(e);
      this.setHovered(view, e);
      view?.hoverMove(e);
    });

    const end = (e: PointerEvent, cancelled: boolean) => {
      const a = this.active;
      if (!a || a.pointerId !== e.pointerId) return false;
      this.active = undefined;
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
      a.view.pointerUp(e, cancelled);
      return true;
    };
    document.addEventListener('pointerup', (e) => {
      if (end(e, false)) return;
      // 中ボタンのクリック (左はドラッグ扱いで上の end に、右は contextmenu に来る)
      if (e.button === 1) this.pick(e)?.click(e);
    });
    document.addEventListener('pointercancel', (e) => void end(e, true));
    root.addEventListener('pointerleave', (e) => {
      if (!this.active) this.setHovered(undefined, e);
    });

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

    document.addEventListener('dblclick', (e) => this.pick(e)?.doubleClick(e));

    document.addEventListener('contextmenu', (e) => {
      if (e.target instanceof Element && e.target.closest('.desktop .balloon')) {
        e.preventDefault();
        this.onBalloonContextMenu(e);
        return;
      }
      const view = this.pick(e);
      if (!view) return;
      e.preventDefault();
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
}
