/** <dialog> を使った画面部品 (確認・入力ボックス・情報・オプション・パッケージ管理・ヘルプ) と通知。 */
import dialogPolyfill from 'dialog-polyfill';
import { language, LANGUAGES, t, type MessageKey } from '../i18n';
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

export type PackageKindName = 'ghost' | 'balloon' | 'shell' | 'supplement' | 'plugin' | 'headline' | 'calendar skin' | 'calendar plugin' | 'language' | 'package';

const KIND_LABELS: Record<PackageKindName, MessageKey> = {
  ghost: 'kind.ghost',
  balloon: 'kind.balloon',
  shell: 'kind.shell',
  supplement: 'kind.supplement',
  plugin: 'kind.plugin',
  headline: 'kind.headline',
  'calendar skin': 'kind.calendarSkin',
  'calendar plugin': 'kind.calendarPlugin',
  language: 'kind.language',
  package: 'kind.package',
};

/** パッケージの種類の表示名 (インストール結果と管理画面で共有) */
export function packageKindLabel(kind: PackageKindName | string): string {
  const key = KIND_LABELS[kind as PackageKindName];
  return key ? t(key) : kind;
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
  // ページ (README) は日本語のまま。ダイアログは画面の言語で読み上げる
  root.lang = language().code;
  const frame = el(container, { className: 'dialog-frame' });
  const heading = el('h2', { className: 'dialog-title', id: titleId }, title);
  const titlebar = el('div', { className: 'dialog-titlebar' }, heading);
  const body = el('div', { className: 'dialog-body' });
  const actions = el('div', { className: 'dialog-actions' });
  // × は最後に置いてタイトルバーへ重ねる (開いたときの最初のフォーカスが本文の入力欄やボタンに来るように)
  const close = button('✕', 'icon', () => root.close(), { ariaLabel: t('common.close') });
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
    const cancel = button(t('common.cancel'), 'secondary', () => root.close());
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

/** 入力ボックスの種類 (\![open,inputbox] / passwordinput / textareabox / dateinput / timeinput / sliderinput / ipinput) */
export type InputType = 'text' | 'password' | 'textarea' | 'date' | 'time' | 'slider' | 'ip';

export interface InputOptions {
  title: string;
  type?: InputType;
  defaultText?: string;
  /** 日付・時刻・IP の初期値 (年,月,日 / 時,分,秒 / 4つの数)、スライダーの値 */
  values?: number[];
  min?: number;
  max?: number;
  placeholder?: string;
  /** 文字数の上限 (--limit) */
  limit?: number;
  /** 入力の候補 (一行の入力欄だけ) */
  suggestions?: string[];
  /** ms。0 以下で無期限 */
  timeout?: number;
  /** 閉じるボタンを出さない (--option=noclose) */
  noClose?: boolean;
}

export type InputBoxResult = { value: string } | { cancelled: 'close' | 'timeout' };

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * ゴーストへの入力ボックス。閉じたか時間切れかを返す。
 * 値は SSP と同じ形: 日付は「年,月,日」、時刻は「時,分,秒」、IP は「a.b.c.d」、複数行は改行をバイト値1に
 */
export class InputBox {
  private current?: { finish(v: InputBoxResult): void };

  /** 開いている入力ボックスがあれば、それを閉じてから開く */
  open(opts: InputOptions): Promise<InputBoxResult> {
    this.close();
    return new Promise((resolve) => {
      const { root, body, actions, titleId } = dialog('input-dialog', opts.title, 'form');
      const form = root.querySelector('form')!;
      const type = opts.type ?? 'text';
      const now = new Date();
      const v = opts.values ?? [];
      let read: () => string;
      let first: HTMLElement;
      if (type === 'textarea') {
        const area = el('textarea', { className: 'text-input text-area', rows: 6 });
        area.value = opts.defaultText ?? '';
        if (opts.placeholder) area.placeholder = opts.placeholder;
        if (opts.limit) area.maxLength = opts.limit;
        area.setAttribute('aria-labelledby', titleId);
        // Ctrl+Enter で決定 (Enter は改行)
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            form.requestSubmit?.() ?? form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        });
        body.appendChild(area);
        read = () => area.value.replace(/\r\n|\r|\n/g, '\x01');
        first = area;
      } else if (type === 'date') {
        const input = el('input', { className: 'text-input', type: 'date' });
        const [y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate()] = v;
        input.value = `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
        input.setAttribute('aria-labelledby', titleId);
        body.appendChild(input);
        read = () => input.value.split('-').map(Number).join(',');
        first = input;
      } else if (type === 'time') {
        const input = el('input', { className: 'text-input', type: 'time', step: '1' });
        const [h = now.getHours(), mi = now.getMinutes(), se = now.getSeconds()] = v;
        input.value = `${pad2(h)}:${pad2(mi)}:${pad2(se)}`;
        input.setAttribute('aria-labelledby', titleId);
        body.appendChild(input);
        read = () => {
          const [hh = 0, mm = 0, ss = 0] = input.value.split(':').map(Number);
          return [hh, mm, ss].join(',');
        };
        first = input;
      } else if (type === 'slider') {
        const min = opts.min ?? 0;
        const max = opts.max ?? 100;
        const range = el('input', { className: 'slider-input', type: 'range', min: String(min), max: String(max), value: String(v[0] ?? min) });
        const out = el('output', { className: 'slider-value' }, range.value);
        range.addEventListener('input', () => (out.textContent = range.value));
        range.setAttribute('aria-labelledby', titleId);
        body.append(range, out);
        read = () => range.value;
        first = range;
      } else if (type === 'ip') {
        const parts = [0, 1, 2, 3].map((i) => {
          const n = el('input', { className: 'text-input ip-part', type: 'number', min: '0', max: '255', value: String(v[i] ?? 0) });
          n.setAttribute('aria-label', t('input.ipPart', { n: i + 1 }));
          return n;
        });
        const row = el('div', { className: 'ip-input' });
        parts.forEach((n, i) => row.append(...(i ? [el('span', {}, '.'), n] : [n])));
        row.setAttribute('aria-labelledby', titleId);
        body.appendChild(row);
        read = () => parts.map((n) => Math.min(255, Math.max(0, Number(n.value) || 0))).join('.');
        first = parts[0];
      } else {
        const input = el('input', {
          className: 'text-input',
          type: type === 'password' ? 'password' : 'text',
          value: opts.defaultText ?? '',
          autocomplete: 'off',
        });
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.limit) input.maxLength = opts.limit;
        input.setAttribute('aria-labelledby', titleId);
        body.appendChild(input);
        if (opts.suggestions?.length && type !== 'password') {
          const list = el('datalist', { id: `${titleId}-list` }, ...opts.suggestions.map((s) => el('option', { value: s })));
          input.setAttribute('list', list.id);
          body.appendChild(list);
        }
        read = () => input.value;
        first = input;
      }
      let timer: number | undefined;
      let done = false;
      const finish = (r: InputBoxResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.current?.finish === finish) this.current = undefined;
        if (root.open) root.close();
        resolve(r);
      };
      const closed = () => finish({ cancelled: 'close' });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish({ value: read() });
      });
      root.addEventListener('cancel', (e) => {
        if (opts.noClose) e.preventDefault();
        else closed();
      });
      root.addEventListener('close', closed);
      if (opts.noClose) root.querySelector('.dialog-close')?.remove();
      const send = button(t('common.send'), 'primary', undefined, { submit: true });
      if (opts.noClose) actions.append(send);
      else actions.append(button(t('common.cancel'), 'secondary', closed), send);
      if (opts.timeout && opts.timeout > 0) timer = window.setTimeout(() => finish({ cancelled: 'timeout' }), opts.timeout);
      this.current = { finish };
      root.showModal();
      first.focus();
      if (first instanceof HTMLInputElement && first.type === 'text') first.select();
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
  /** 通知の本文を押した (トレイのバルーンのクリック) */
  onClick?(): void;
  /** 本文を押さずに消えた (時間切れ・✕・アクション) */
  onClose?(): void;
  /** 見出し (トレイのバルーンのタイトル) */
  title?: string;
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
    const text = el('span', { className: 'toast-text' }, ...(opts.title ? [el('strong', { className: 'toast-title' }, opts.title), el('br'), message] : [message]));
    const toast = el('div', { className: `toast${opts.error ? ' toast-error' : ''}` }, text);
    if (opts.error) toast.setAttribute('role', 'alert');
    let timer: number | undefined;
    let hovered = false;
    let clicked = false;
    const remove = () => {
      clearTimeout(timer);
      if (!toast.isConnected) return;
      if (!clicked) opts.onClose?.();
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
    if (opts.onClick) {
      text.classList.add('toast-clickable');
      text.tabIndex = 0;
      text.setAttribute('role', 'button');
      const click = () => {
        clicked = true;
        remove();
        opts.onClick?.();
      };
      text.addEventListener('click', click);
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          click();
        }
      });
    }
    toast.appendChild(button('✕', 'icon', remove, { ariaLabel: t('common.close') }));
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
  actions.appendChild(button(t('common.close'), 'primary', () => root.close()));
  root.showModal();
}

export interface OptionsModel {
  talkWait: number;
  balloonTimeout: number;
  choiceTimeout: number;
  scale: number;
  /** バルーンの拡大率 (シェルと別にする) */
  balloonScale: number;
  userName: string;
  /** 音声合成で読み上げる */
  speech: boolean;
  /** 他のゴーストが SSTP などで割り込むのを受ける */
  acceptRemoteSstp: boolean;
  /** 音声認識で話しかける */
  voiceRecognition: boolean;
  /** 画面の言語 (LANGUAGES の code)。undefined ならブラウザの言語に合わせる */
  language: string | undefined;
}

/** 入力欄の範囲。保存時の丸めにも同じ値を使う */
const LIMITS = {
  talkWait: { min: 0, max: 500, step: 5 },
  seconds: { min: 0, max: 600, step: 1 },
  scale: { min: 25, max: 300, step: 5 },
};

/** オプション (表示速度・拡大率など)。Enter で保存、範囲外はブラウザの検証で知らせる。 */
/**
 * on.help はページごとの「?」(SSP の設定ダイアログのヘルプ。ゴーストに OnConfigurationDialogHelp で知らせる)。
 * ページの ID は SSP と同じもの (display・dictation・network・setup)
 */
export function showOptions(model: OptionsModel, on: { save(m: OptionsModel): void; help?(id: string): void; browserLanguage: string }): void {
  const { root, body, actions } = dialog('options-dialog', t('options.title'), 'form');
  const form = root.querySelector('form')!;

  const field = (label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string) => {
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
  const balloonScale = number(Math.round(model.balloonScale * 100), LIMITS.scale);
  const check = (checked: boolean) => el('input', { type: 'checkbox', className: 'check-input', checked });
  const speech = check(model.speech);
  const voice = check(model.voiceRecognition);
  const sstp = check(model.acceptRemoteSstp);
  /** 見出しと、そのページのヘルプ (?) */
  const page = (title: string, id: string) => {
    const h = section(title);
    if (on.help) {
      const q = button('?', 'icon', () => on.help!(id), { ariaLabel: t('options.help', { title }) });
      q.classList.add('section-help');
      h.appendChild(q);
    }
    return h;
  };
  // 空白だけの呼び名もブラウザの検証で止める (黙って前の名前に戻さない)
  const user = el('input', {
    className: 'text-input',
    type: 'text',
    required: true,
    pattern: '.*\\S.*',
    title: t('options.userNameBlank'),
    value: model.userName,
    autocomplete: 'off',
  });
  // 言語の名前はその言語で書く (いまの言語が読めなくても選べるように)。空の値はブラウザの言語に合わせる
  const lang = el(
    'select',
    { className: 'text-input' },
    el('option', { value: '' }, t('options.browserLanguage', { name: on.browserLanguage })),
    ...LANGUAGES.map((l) => el('option', { value: l.code, lang: l.code }, l.name)),
  );
  lang.value = model.language ?? '';

  body.append(
    page(t('options.display'), 'display'),
    field(t('options.talkWait'), talkWait),
    field(t('options.balloonTimeout'), balloon, t('options.zeroDisables')),
    field(t('options.choiceTimeout'), choice, t('options.zeroDisables')),
    field(t('options.shellScale'), scale),
    field(t('options.balloonScale'), balloonScale),
    page(t('options.speech'), 'dictation'),
    field(t('options.speechOut'), speech, t('options.speechOutHint')),
    field(t('options.voiceIn'), voice, t('options.voiceInHint')),
    page(t('options.network'), 'network'),
    field(t('options.remoteSstp'), sstp, t('options.remoteSstpHint')),
    page(t('options.user'), 'setup'),
    field(t('options.userName'), user, t('options.userNameHint')),
    // SSP の設定ダイアログに言語のページは無いので、ゴーストに聞くヘルプ (?) は付けない
    section(t('options.language')),
    field(t('options.languageField'), lang, t('options.languageHint')),
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
      balloonScale: clamp(balloonScale.valueAsNumber, LIMITS.scale) / 100,
      userName: user.value.trim() || model.userName,
      speech: speech.checked,
      acceptRemoteSstp: sstp.checked,
      voiceRecognition: voice.checked,
      language: lang.value || undefined,
    };
    // 先に閉じてから保存する (保存の結果はダイアログの外の通知で知らせるため)
    root.close();
    on.save(values);
  });
  const save = button(t('common.save'), 'primary', undefined, { submit: true });
  actions.append(button(t('common.cancel'), 'secondary', () => root.close()), save);
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
  const { root, body, actions } = dialog('packages-dialog', t('packages.title'));
  const status = el('p', { className: 'dialog-status' });
  status.setAttribute('role', 'status');
  const list = el('ul', { className: 'package-list' });
  const empty = () => el('li', { className: 'package-row' }, t('packages.empty'));
  for (const p of packages) {
    const item = el(
      'li',
      { className: 'package-row' },
      el('span', { className: 'package-kind' }, packageKindLabel(p.kind)),
      el('span', { className: 'package-name' }, p.name),
    );
    if (p.running) {
      item.appendChild(el('span', { className: 'package-state' }, t('packages.running')));
    } else {
      const remove = button(t('common.delete'), 'danger', undefined, { ariaLabel: t('packages.deleteNamed', { name: p.name }) });
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('packages.confirmTitle', { name: p.name }),
          message: p.kind === 'ghost' ? t('packages.confirmGhost') : t('packages.confirm'),
          confirmLabel: t('common.delete'),
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
          status.textContent = note ? t('packages.deletedNote', { name: p.name, note }) : t('packages.deleted', { name: p.name });
          next.focus();
        } catch (e) {
          remove.disabled = false;
          status.textContent = t('toast.deleteFailed', { name: p.name, error: (e as Error).message });
          remove.focus();
        }
      });
      item.appendChild(remove);
    }
    list.appendChild(item);
  }
  if (packages.length === 0) list.appendChild(empty());
  body.append(list, status);
  const close = button(t('common.close'), 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
}

/** ライセンス (組み込んでいる SHIORI とライブラリの著作権表示・条文) */
export function showLicenses(text: string): void {
  const { root, body, actions, titleId } = dialog('help-dialog', t('licenses.title'));
  body.appendChild(el('pre', { className: 'license-text' }, text));
  // 本文は読むだけなので、キーボードでもスクロールできるようフォーカスを受ける
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-labelledby', titleId);
  const close = button(t('common.close'), 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
  body.scrollTop = 0;
  close.focus();
}

/** ヘルプ (README を読みやすくしたもの。README は日本語なので、本文は日本語として読み上げる) */
export function showHelp(markdown: string): void {
  const { root, body, actions, titleId } = dialog('help-dialog', t('help.title'));
  body.lang = 'ja';
  body.appendChild(renderMarkdown(markdown));
  // 本文は読むだけなので、キーボードでもスクロールできるようフォーカスを受ける (読み上げではヘルプの本文と分かるように)
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-labelledby', titleId);
  const close = button(t('common.close'), 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
  body.scrollTop = 0;
  close.focus();
}

/** 読むだけの文 (readme・terms・ログなど)。pre なら等幅のまま */
/** actions は押したらダイアログを閉じてから run する (利用条件の受諾・拒否など) */
export function showText(title: string, text: string, opts: { pre?: boolean; actions?: { label: string; run(): void }[]; closeLabel?: string } = {}): void {
  const { root, body, actions, titleId } = dialog('help-dialog', title);
  body.appendChild(opts.pre === false ? el('div', { className: 'plain-text' }, text) : el('pre', { className: 'license-text' }, text));
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-labelledby', titleId);
  for (const a of opts.actions ?? []) {
    actions.appendChild(
      button(a.label, 'secondary', () => {
        root.close();
        a.run();
      }),
    );
  }
  const close = button(opts.closeLabel ?? t('common.close'), 'primary', () => root.close());
  actions.appendChild(close);
  root.showModal();
  body.scrollTop = 0;
  close.focus();
}

/** 自由な中身のダイアログ (開発用パレット・サーフェステストなど)。閉じたら onClose */
export function showPanel(title: string, content: HTMLElement, onClose?: () => void): { close(): void } {
  const { root, body, actions } = dialog('panel-dialog', title);
  body.appendChild(content);
  const close = button(t('common.close'), 'primary', () => root.close());
  actions.appendChild(close);
  root.addEventListener('close', () => onClose?.());
  root.showModal();
  return { close: () => root.close() };
}
