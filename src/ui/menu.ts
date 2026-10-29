import { el, tokenPx } from './dom';

export interface MenuItem {
  label?: string;
  action?: () => void;
  submenu?: MenuItem[];
  /** 選択状態を持つ項目。radio は1つだけ選ぶ組 (シェル・バルーンなど)、checkbox は個別に切り替える (着せ替え) */
  check?: 'radio' | 'checkbox';
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

/**
 * 右クリックメニュー (オーナードローメニュー相当)。
 * 項目は roving tabindex で、矢印キー・Home/End・Enter/Space・Escape・←/→ で操作する。Tab で閉じる。
 */
export class ContextMenu {
  /** 開閉を知らせる (トレイボタンの aria-expanded 用) */
  onToggle?: (open: boolean) => void;

  private readonly root = el('div', { className: 'menu-layer', hidden: true });
  private levels: HTMLElement[] = [];
  /** サブメニュー → それを開いた項目 */
  private readonly openers = new WeakMap<HTMLElement, HTMLElement>();
  private returnFocus: HTMLElement | null = null;

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    // フォーカスがメニューの外へ移ったら閉じる (フォーカスは移った先のまま)
    this.root.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && !this.root.contains(next)) this.close(false);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** above: y をメニューの下端にする (画面下のボタンから開くとき) */
  open(items: MenuItem[], x: number, y: number, above = false): void {
    this.close(false);
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    const list = this.renderList(items, 0);
    const gutter = tokenPx('--space-2', 8);
    this.position(list, x, above ? y - list.offsetHeight - gutter : y, null);
    this.items(list)[0]?.focus();
    this.onToggle?.(true);
  }

  close(restoreFocus = true): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.levels = [];
    if (restoreFocus) this.returnFocus?.focus?.();
    this.returnFocus = null;
    this.onToggle?.(false);
  }

  private items(list: HTMLElement): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(':scope > .menu-item')];
  }

  /** depth より深いサブメニューを消す。消すメニューにフォーカスがあれば、それを開いた項目へ戻す */
  private trim(depth: number): void {
    const removed = this.levels.slice(depth);
    if (removed.length === 0) return;
    const hadFocus = removed.some((level) => level.contains(document.activeElement));
    for (const level of removed) {
      this.openers.get(level)?.setAttribute('aria-expanded', 'false');
      level.remove();
    }
    this.levels.length = depth;
    if (hadFocus) this.openers.get(removed[0])?.focus();
  }

  private renderList(items: MenuItem[], depth: number): HTMLElement {
    this.trim(depth);
    const list = el('div', { className: 'menu' });
    list.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        const sep = el('div', { className: 'menu-separator' });
        sep.setAttribute('role', 'separator');
        list.appendChild(sep);
        continue;
      }
      const btn = el('button', { type: 'button', className: 'menu-item', tabIndex: -1 });
      btn.setAttribute('role', item.check === 'radio' ? 'menuitemradio' : item.check === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
      if (item.check) btn.setAttribute('aria-checked', String(!!item.checked));
      const check = el('span', { className: 'menu-check' }, item.checked ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      btn.append(check, el('span', { className: 'menu-label' }, item.label ?? ''));
      // 無効な項目もフォーカスは受ける (読み上げで存在が分かるように)
      const disabled = !!item.disabled || (item.submenu !== undefined && item.submenu.length === 0);
      if (disabled) btn.setAttribute('aria-disabled', 'true');

      if (item.submenu) {
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        const arrow = el('span', { className: 'menu-arrow' }, '›');
        arrow.setAttribute('aria-hidden', 'true');
        btn.appendChild(arrow);
        const openSub = (): HTMLElement | undefined => {
          if (disabled || !item.submenu) return undefined;
          if (this.levels[depth + 1] && this.openers.get(this.levels[depth + 1]) === btn) return this.levels[depth + 1];
          const sub = this.renderList(item.submenu, depth + 1);
          this.openers.set(sub, btn);
          btn.setAttribute('aria-expanded', 'true');
          this.position(sub, 0, 0, btn);
          return sub;
        };
        btn.addEventListener('pointerenter', () => void openSub());
        btn.addEventListener('click', () => {
          const sub = openSub();
          if (sub) this.items(sub)[0]?.focus();
        });
      } else {
        btn.addEventListener('pointerenter', () => this.trim(depth + 1));
        btn.addEventListener('click', () => {
          if (disabled) return;
          this.close();
          item.action?.();
        });
      }
      list.appendChild(btn);
    }
    this.root.appendChild(list);
    this.levels.push(list);
    return list;
  }

  /** 画面からはみ出さないように置く。anchor があればその右 (入らなければ左) に出す。 */
  private position(list: HTMLElement, x: number, y: number, anchor: HTMLElement | null): void {
    const gutter = tokenPx('--space-2', 8);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    let left = x;
    let top = y;
    if (anchor) {
      // 親メニューの縁に少し重ねて出す
      const r = anchor.getBoundingClientRect();
      left = r.right - gutter / 2;
      top = r.top - gutter / 2;
      if (left + w > vw - gutter) left = r.left - w + gutter / 2;
    } else if (left + w > vw - gutter) {
      left = x - w;
    }
    left = Math.min(Math.max(gutter, left), Math.max(gutter, vw - w - gutter));
    top = Math.min(Math.max(gutter, top), Math.max(gutter, vh - h - gutter));
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
  }

  private onKey(e: KeyboardEvent): void {
    const current = document.activeElement as HTMLElement | null;
    const list = current?.closest('.menu') as HTMLElement | null;
    if (!list) return;
    const items = this.items(list);
    const i = items.indexOf(current as HTMLElement);
    const depth = this.levels.indexOf(list);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'Escape':
        handled();
        if (depth > 0) this.closeLevel(depth);
        else this.close();
        break;
      case 'Tab':
        handled();
        this.close();
        break;
      case 'ArrowDown':
        handled();
        items[(i + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        handled();
        items[(i - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        handled();
        items[0]?.focus();
        break;
      case 'End':
        handled();
        items[items.length - 1]?.focus();
        break;
      case 'ArrowRight':
        if (current?.getAttribute('aria-haspopup')) {
          handled();
          current.click();
        }
        break;
      case 'ArrowLeft':
        if (depth > 0) {
          handled();
          this.closeLevel(depth);
        }
        break;
    }
  }

  /** depth 以下のサブメニューを閉じ、開いた項目へフォーカスを戻す */
  private closeLevel(depth: number): void {
    const opener = this.openers.get(this.levels[depth]);
    this.trim(depth);
    opener?.focus();
  }
}
