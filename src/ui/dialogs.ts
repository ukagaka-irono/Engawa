/** <dialog> を使った画面部品 (確認・入力ボックス・情報・オプション・パッケージ管理・ヘルプ) と通知。 */
import dialogPolyfill from 'dialog-polyfill';
import { el, uniqueId } from './dom';
import { renderMarkdown } from './markdown';

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'icon';

export interface ButtonOptions {
  /** 見た目の文字と別の読み上げ名 (× ボタンなど) */
  ariaLabel?: string;
  /** フォームのダイアログで、Enter で押される送信ボタンにする */
  submit?: boolean;
}

export function button(label: string, kind: ButtonKind = 'secondary', onClick?: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const b = el('button', { type: opts.submit ? 'submit' : 'button', className: `btn btn-${kind}` }, label);
  if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export type PackageKindName = 'ghost' | 'balloon' | 'shell' | 'supplement';

const KIND_LABELS: Record<PackageKindName, string> = { ghost: 'ゴースト', balloon: 'バルーン', shell: 'シェル', supplement: '追加ファイル' };

/** パッケージの種類の表示名 (インストール結果と管理画面で共有) */
export function packageKindLabel(kind: PackageKindName | string): string {
  return KIND_LABELS[kind as PackageKindName] ?? kind;
}

interface DialogParts {
  root: HTMLDialogElement;
  body: HTMLElement;
  actions: HTMLElement;
  titleId: string;
}

let dialogParent: HTMLElement | undefined;

/** ダイアログを置く場所 (既定は body)。よそのページに埋め込むときは Engawa の入れ物の中に置き、そこの CSS を効かせる */
export function setDialogParent(parent: HTMLElement): void {
  dialogParent = parent;
}

/**
 * すべてのモーダルはここから作る。Windows のウィンドウのように、タイトルバーの見出しがダイアログの名前になり、
 * 右端の × で閉じる (Escape と同じ。Tab の順には入れない)。
 */
function dialog(className: string, title: string, container: 'div' | 'form' = 'div'): DialogParts {
  const titleId = uniqueId('dialog-title');
  const root = el('dialog', { className: `dialog ${className}` });
  root.setAttribute('aria-labelledby', titleId);
  const frame = el(container, { className: 'dialog-frame' });
  const heading = el('h2', { className: 'dialog-title', id: titleId }, title);
  const titlebar = el('div', { className: 'dialog-titlebar' }, heading);
  const body = el('div', { className: 'dialog-body' });
  const actions = el('div', { className: 'dialog-actions' });
  // × は最後に置いてタイトルバーへ重ねる (開いたときの最初のフォーカスが本文の入力欄やボタンに来るように)
  const close = button('✕', 'icon', () => root.close(), { ariaLabel: '閉じる' });
  close.classList.add('dialog-close');
  close.tabIndex = -1;
  frame.append(titlebar, body, actions, close);
  root.appendChild(frame);
  (dialogParent ?? document.body).appendChild(root);
  // <dialog> の無いブラウザ (Safari 15.3 以前) では dialog-polyfill で同じように動かす (見た目は .dialog-polyfilled)
  if (typeof HTMLDialogElement !== 'function') {
    dialogPolyfill.registerDialog(root);
    root.classList.add('dialog-polyfilled');
  }
  root.addEventListener('close', () => root.remove());
  return { root, body, actions, titleId };
}

function section(title: string): HTMLElement {
  return el('h3', { className: 'dialog-section' }, title);
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

/** 確認ダイアログ。取り消せない操作では、最初のフォーカスをキャンセルに置く。 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { root, body, actions } = dialog('confirm-dialog', opts.title);
    body.appendChild(el('p', { className: 'dialog-text' }, opts.message));
    let answer = false;
    const cancel = button('キャンセル', 'secondary', () => root.close());
    const ok = button(opts.confirmLabel, opts.danger ? 'danger' : 'primary', () => {
      answer = true;
      root.close();
    });
    actions.append(cancel, ok);
    root.addEventListener('close', () => resolve(answer));
    root.showModal();
    (opts.danger ? cancel : ok).focus();
  });
}

export interface InputOptions {
  title: string;
  defaultText?: string;
  password?: boolean;
  /** ms。0 以下で無期限 */
  timeout?: number;
}

export type InputBoxResult = { value: string } | { cancelled: 'close' | 'timeout' };

/** ゴーストへの入力ボックス (communicatebox / inputbox)。閉じたか時間切れかを返す。 */
export class InputBox {
  private current?: { finish(v: InputBoxResult): void };

  /** 開いている入力ボックスがあれば、それを閉じてから開く */
  open(opts: InputOptions): Promise<InputBoxResult> {
    this.close();
    return new Promise((resolve) => {
      const { root, body, actions, titleId } = dialog('input-dialog', opts.title, 'form');
      const form = root.querySelector('form')!;
      const input = el('input', {
        className: 'text-input',
        type: opts.password ? 'password' : 'text',
        value: opts.defaultText ?? '',
        autocomplete: 'off',
      });
      input.setAttribute('aria-labelledby', titleId);
      body.appendChild(input);
      let timer: number | undefined;
      let done = false;
      const finish = (v: InputBoxResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.current?.finish === finish) this.current = undefined;
        if (root.open) root.close();
        resolve(v);
      };
      const closed = () => finish({ cancelled: 'close' });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish({ value: input.value });
      });
      root.addEventListener('cancel', closed);
      root.addEventListener('close', closed);
      const send = button('送信', 'primary', undefined, { submit: true });
      actions.append(button('キャンセル', 'secondary', closed), send);
      if (opts.timeout && opts.timeout > 0) timer = window.setTimeout(() => finish({ cancelled: 'timeout' }), opts.timeout);
      this.current = { finish };
      root.showModal();
      input.focus();
      input.select();
    });
  }

  get isOpen(): boolean {
    return this.current !== undefined;
  }

  close(): void {
    this.current?.finish({ cancelled: 'close' });
  }
}

export interface ToastOptions {
  error?: boolean;
  actions?: { label: string; run(): void }[];
  duration?: number;
}

/**
 * 画面上部の短い通知。アクションボタンを付けられる。
 * ふだんはメニューの下に重なる。モーダルが開いているときだけ、その上に見えるようポップオーバー (最前面) にする
 * (モーダルの外は操作できないので、モーダル中の結果はダイアログの中で知らせ、通知は表示のためだけに使う)。
 */
export class Toasts {
  private readonly box = el('div', { className: 'toasts' });
  private readonly topLayer = 'showPopover' in HTMLElement.prototype;

  /** @param fallbackFocus フォーカスを持った通知が消えたときに移す先 */
  constructor(
    parent: HTMLElement,
    private readonly fallbackFocus: () => HTMLElement | null,
  ) {
    this.box.setAttribute('aria-live', 'polite');
    if (this.topLayer) this.box.popover = 'manual';
    parent.appendChild(this.box);
    // 最後のモーダルが閉じたら最前面をやめ、メニューの下に戻る (close は伝わらないので捕捉で受ける)
    document.addEventListener(
      'close',
      (e) => {
        // HTMLDialogElement の無いブラウザもあるので要素名で見る
        if (e.target instanceof Element && e.target.localName === 'dialog' && !document.querySelector('dialog[open]')) this.leaveTopLayer();
      },
      true,
    );
  }

  show(message: string, opts: ToastOptions = {}): void {
    const toast = el('div', { className: `toast${opts.error ? ' toast-error' : ''}` }, el('span', { className: 'toast-text' }, message));
    if (opts.error) toast.setAttribute('role', 'alert');
    let timer: number | undefined;
    let hovered = false;
    const remove = () => {
      clearTimeout(timer);
      const hadFocus = toast.contains(document.activeElement);
      toast.remove();
      if (hadFocus) this.fallbackFocus()?.focus();
      if (this.box.childElementCount === 0) this.leaveTopLayer();
    };
    const duration = opts.duration ?? (opts.actions?.length ? 15_000 : 6_000);
    const arm = () => {
      clearTimeout(timer);
      timer = window.setTimeout(remove, duration);
    };
    // 読んでいる間・操作している間は消さない
    toast.addEventListener('mouseenter', () => {
      hovered = true;
      clearTimeout(timer);
    });
    toast.addEventListener('mouseleave', () => {
      hovered = false;
      if (!toast.contains(document.activeElement)) arm();
    });
    toast.addEventListener('focusin', () => clearTimeout(timer));
    toast.addEventListener('focusout', (e) => {
      if (!hovered && !toast.contains(e.relatedTarget as Node | null)) arm();
    });
    for (const a of opts.actions ?? []) {
      toast.appendChild(
        button(a.label, 'secondary', () => {
          remove();
          a.run();
        }),
      );
    }
    toast.appendChild(button('✕', 'icon', remove, { ariaLabel: '閉じる' }));
    this.box.appendChild(toast);
    if (document.querySelector('dialog[open]')) this.enterTopLayer();
    arm();
  }

  /** 後から開いたモーダルより上に来るよう、出し直して最前面へ (フォーカスは保つ) */
  private enterTopLayer(): void {
    if (!this.topLayer) return;
    const focused = this.box.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    if (this.box.matches(':popover-open')) this.box.hidePopover();
    this.box.showPopover();
    focused?.focus();
  }

  private leaveTopLayer(): void {
    if (this.topLayer && this.box.matches(':popover-open')) this.box.hidePopover();
  }
}

export interface InfoRow {
  label: string;
  value: string;
  href?: string;
}

/** 名前と値の一覧を見せるだけのダイアログ (ゴーストの情報など) */
export function showInfo(title: string, sections: { heading: string; rows: InfoRow[] }[]): void {
  const { root, body, actions } = dialog('info-dialog', title);
  for (const s of sections) {
    body.appendChild(section(s.heading));
    const dl = el('dl', { className: 'info-list' });
    for (const r of s.rows) {
      if (!r.value) continue;
      const value = r.href ? el('a', { className: 'link', href: r.href, target: '_blank', rel: 'noopener' }, r.value) : r.value;
      dl.append(el('dt', {}, r.label), el('dd', {}, value));
    }
    body.appendChild(dl);
  }
  actions.appendChild(button('閉じる', 'primary', () => root.close()));
  root.showModal();
}

export interface OptionsModel {
  talkWait: number;
  balloonTimeout: number;
  choiceTimeout: number;
  scale: number;
  userName: string;
}

/** 入力欄の範囲。保存時の丸めにも同じ値を使う */
const LIMITS = {
  talkWait: { min: 0, max: 500, step: 5 },
  seconds: { min: 0, max: 600, step: 1 },
  scale: { min: 25, max: 300, step: 5 },
};

/** オプション (表示速度・拡大率など)。Enter で保存、範囲外はブラウザの検証で知らせる。 */
export function showOptions(model: OptionsModel, on: { save(m: OptionsModel): void }): void {
  const { root, body, actions } = dialog('options-dialog', 'オプション', 'form');
  const form = root.querySelector('form')!;

  const field = (label: string, input: HTMLInputElement, hint?: string) => {
    input.id = uniqueId('opt');
    const row = el('div', { className: 'field' }, el('label', { htmlFor: input.id }, label), input);
    if (hint) {
      const hintEl = el('span', { className: 'field-hint', id: uniqueId('opt-hint') }, hint);
      input.setAttribute('aria-describedby', hintEl.id);
      row.appendChild(hintEl);
    }
    return row;
  };
  const number = (value: number, limit: { min: number; max: number; step: number }) =>
    el('input', {
      className: 'text-input',
      type: 'number',
      required: true,
      value: String(value),
      min: String(limit.min),
      max: String(limit.max),
      step: String(limit.step),
    });

  const talkWait = number(model.talkWait, LIMITS.talkWait);
  const balloon = number(Math.round(model.balloonTimeout / 1000), LIMITS.seconds);
  const choice = number(Math.round(model.choiceTimeout / 1000), LIMITS.seconds);
  const scale = number(Math.round(model.scale * 100), LIMITS.scale);
  // 空白だけの呼び名もブラウザの検証で止める (黙って前の名前に戻さない)
  const user = el('input', {
    className: 'text-input',
    type: 'text',
    required: true,
    pattern: '.*\\S.*',
    title: '空白だけの呼び名にはできません',
    value: model.userName,
    autocomplete: 'off',
  });

  body.append(
    section('表示'),
    field('文字の表示間隔 (ms)', talkWait),
    field('バルーンのタイムアウト (秒)', balloon, '0 で無効'),
    field('選択肢のタイムアウト (秒)', choice, '0 で無効'),
    field('拡大率 (%)', scale),
    section('ユーザー'),
    field('呼び名', user, 'ゴーストがあなたの呼び名を知らないときに使います'),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const clamp = (v: number, l: { min: number; max: number }) => Math.min(l.max, Math.max(l.min, v));
    const values: OptionsModel = {
      talkWait: clamp(talkWait.valueAsNumber, LIMITS.talkWait),
      balloonTimeout: clamp(balloon.valueAsNumber, LIMITS.seconds) * 1000,
      choiceTimeout: clamp(choice.valueAsNumber, LIMITS.seconds) * 1000,
      scale: clamp(scale.valueAsNumber, LIMITS.scale) / 100,
      userName: user.value.trim() || model.userName,
    };
    // 先に閉じてから保存する (保存の結果はダイアログの外の通知で知らせるため)
    root.close();
    on.save(values);
  });
  const save = button('保存', 'primary', undefined, { submit: true });
  actions.append(button('キャンセル', 'secondary', () => root.close()), save);
  root.showModal();
}

export interface PackageRow {
  key: string;
  kind: PackageKindName;
  name: string;
  running: boolean;
}

/**
 * インストール済みパッケージの一覧と削除。結果はダイアログ内に知らせる。
 * uninstall は削除できなければ例外を投げ、削除後の片付けで問題があればその説明を返す。
 */
export function showPackages(packages: PackageRow[], on: { uninstall(row: PackageRow): Promise<string | void> }): void {
  const { root, body, actions } = dialog('packages-dialog', 'インストール済み');
  const status = el('p', { className: 'dialog-status' });
  status.setAttribute('role', 'status');
  const list = el('ul', { className: 'package-list' });
  const empty = () => el('li', { className: 'package-row' }, 'ありません');
  for (const p of packages) {
    const item = el(
      'li',
      { className: 'package-row' },
      el('span', { className: 'package-kind' }, packageKindLabel(p.kind)),
      el('span', { className: 'package-name' }, p.name),
    );
    if (p.running) {
      item.appendChild(el('span', { className: 'package-state' }, '起動中'));
    } else {
      const remove = button('削除', 'danger', undefined, { ariaLabel: `「${p.name}」を削除` });
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `「${p.name}」を削除しますか？`,
          message: p.kind === 'ghost' ? 'セーブデータも一緒に消えます。元に戻せません。' : '元に戻せません。',
          confirmLabel: '削除',
          danger: true,
        });
        if (!ok) return;
        remove.disabled = true;
        try {
          const note = await on.uninstall(p);
          // 消えた行の代わりに、一覧の次の削除ボタン (無ければ閉じるボタン) へフォーカスを移す
          const next = (item.nextElementSibling ?? item.previousElementSibling)?.querySelector('button') ?? close;
          item.remove();
          if (list.childElementCount === 0) list.appendChild(empty());
          status.textContent = note ? `「${p.name}」を削除しました (${note})` : `「${p.name}」を削除しました`;
          next.focus();
        } catch (e) {
          remove.disabled = false;
          status.textContent = `「${p.name}」を削除できませんでした: ${(e as Error).message}`;
          remove.focus();
        }
      });
      item.appendChild(remove);
    }
    list.appendChild(item);
  }
  if (packages.length === 0) list.appendChild(empty());
  body.append(list, status);
  const close = button('閉じる', 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
}

/** ライセンス (組み込んでいる SHIORI とライブラリの著作権表示・条文) */
export function showLicenses(text: string): void {
  const { root, body, actions, titleId } = dialog('help-dialog', 'ライセンス');
  body.appendChild(el('pre', { className: 'license-text' }, text));
  // 本文は読むだけなので、キーボードでもスクロールできるようフォーカスを受ける
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-labelledby', titleId);
  const close = button('閉じる', 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
  body.scrollTop = 0;
  close.focus();
}

/** ヘルプ (README を読みやすくしたもの) */
export function showHelp(markdown: string): void {
  const { root, body, actions, titleId } = dialog('help-dialog', 'ヘルプ');
  body.appendChild(renderMarkdown(markdown));
  // 本文は読むだけなので、キーボードでもスクロールできるようフォーカスを受ける (読み上げではヘルプの本文と分かるように)
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-labelledby', titleId);
  const close = button('閉じる', 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
  body.scrollTop = 0;
  close.focus();
}
