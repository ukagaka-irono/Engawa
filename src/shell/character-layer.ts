import type { CharacterView } from './character-view';

/**
 * デスクトップ上のキャラクターへのマウス・タッチ入力をまとめて振り分ける。
 * 各キャラクターの canvas は矩形なので、上にあるキャラクターの透明な部分が下のキャラクターを
 * 隠してしまう。ここで上から順に「そのピクセルが不透明なキャラクター」を探して渡す (SSP のウィンドウ同様)。
 */
export class CharacterLayer {
  private readonly views: CharacterView[] = [];
  private active?: { view: CharacterView; pointerId: number };
  private hovered?: CharacterView;

  constructor(
    readonly desktop: HTMLElement,
    /** キャラクターの無い所 (やバルーン) での右クリック */
    private readonly onDesktopContextMenu: (e: MouseEvent) => void,
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

  /** その位置で一番上にある、不透明なピクセルを持つキャラクター */
  private pick(e: MouseEvent): CharacterView | undefined {
    if ((e.target as Element | null)?.closest?.('.balloon')) return undefined;
    const dragging = this.active?.view;
    if (dragging?.hit(e.clientX, e.clientY)) return dragging;
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
    this.desktop.style.cursor = view ? 'pointer' : '';
  }

  private bind(): void {
    const d = this.desktop;
    d.addEventListener('pointerdown', (e) => {
      const view = this.pick(e);
      if (!view) return;
      view.pointerDown(e);
      if (e.button !== 0) return;
      this.active = { view, pointerId: e.pointerId };
      d.setPointerCapture(e.pointerId);
    });

    d.addEventListener('pointermove', (e) => {
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
      if (d.hasPointerCapture(e.pointerId)) d.releasePointerCapture(e.pointerId);
      a.view.pointerUp(e, cancelled);
      return true;
    };
    d.addEventListener('pointerup', (e) => {
      if (end(e, false)) return;
      // 中ボタンのクリック (左はドラッグ扱いで上の end に、右は contextmenu に来る)
      if (e.button === 1) this.pick(e)?.click(e);
    });
    d.addEventListener('pointercancel', (e) => void end(e, true));
    d.addEventListener('pointerleave', (e) => {
      if (!this.active) this.setHovered(undefined, e);
    });

    d.addEventListener('dblclick', (e) => this.pick(e)?.doubleClick(e));

    d.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const view = this.pick(e);
      if (view) view.contextMenu(e);
      else this.onDesktopContextMenu(e);
    });

    d.addEventListener(
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
