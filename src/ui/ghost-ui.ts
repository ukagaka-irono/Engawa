import { el } from './dom';

/**
 * ゴーストが使う小さな画面部品: 当たり判定のツールチップ、\![open,dialog,…] のファイル選択、ダウンロード。
 */

let tooltip: HTMLElement | undefined;

/** ツールチップを (x, y) の少し下に出す。デスクトップからはみ出さないようにする */
export function showTooltip(desktop: HTMLElement, text: string, x: number, y: number): void {
  tooltip ??= el('div', { className: 'engawa-tooltip' });
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = text;
  if (tooltip.parentElement !== desktop) desktop.appendChild(tooltip);
  tooltip.hidden = false;
  const box = desktop.getBoundingClientRect();
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  const left = Math.min(Math.max(0, x - box.left + 12), Math.max(0, box.width - w));
  const top = Math.min(y - box.top + 20, Math.max(0, box.height - h));
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export function hideTooltip(): void {
  if (tooltip) tooltip.hidden = true;
}

/** ダウンロードさせる (\![execute,createnar]・\![open,dialog,save] で返したパスへの書き込み) */
export function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export interface SystemDialogResult {
  value: string;
  files?: PickedFile[];
}

/** 開いている \![open,dialog] (ID ごと)。閉じられたら undefined で終わる */
const openDialogs = new Map<string, () => void>();

/** --name=値 */
function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((a) => a.toLowerCase().startsWith(prefix))?.slice(prefix.length);
}

/** --filter=説明|*.txt;*.dic|… を accept 属性にする */
function accept(filter: string | undefined): string {
  if (!filter) return '';
  const parts = filter.split('|');
  const exts = parts.filter((_, i) => i % 2 === 1).flatMap((p) => p.split(';'));
  if (exts.some((e) => e.trim() === '*.*' || e.trim() === '*')) return '';
  return exts
    .map((e) => /\*(\.[^.*]+)$/.exec(e.trim())?.[1])
    .filter(Boolean)
    .join(',');
}

/**
 * \![open,dialog,open|save|folder|color,…]。open はファイルを選ばせて読み、save は名前を聞いて download/ のパスを返す。
 * folder はブラウザでは選べないので取り消しにする。取り消されたら undefined
 */
export function openSystemDialog(kind: string, args: string[], id: string): Promise<SystemDialogResult | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: SystemDialogResult | undefined) => {
      if (done) return;
      done = true;
      openDialogs.delete(id);
      resolve(r);
    };
    openDialogs.set(id, () => finish(undefined));
    if (kind === 'open') {
      const input = el('input', { type: 'file' });
      input.accept = accept(option(args, 'filter'));
      input.multiple = args.some((a) => a.toLowerCase() === '--multiple');
      input.addEventListener('change', async () => {
        const files = await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
        finish(files.length ? { value: '', files } : undefined);
      });
      input.addEventListener('cancel', () => finish(undefined));
      input.click();
      return;
    }
    if (kind === 'save') {
      const ext = option(args, 'ext');
      const fallback = `${option(args, 'name') ?? 'untitled'}${ext ? `.${ext}` : ''}`;
      const name = window.prompt(option(args, 'title') ?? '保存するファイルの名前', fallback);
      finish(name ? { value: `download/${name.replace(/[\\/:*?"<>|]/g, '_')}` } : undefined);
      return;
    }
    if (kind === 'color') {
      const input = el('input', { type: 'color' });
      const rgb = (option(args, 'color') ?? '').split(/\s+/).map(Number);
      if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) input.value = `#${rgb.map((n) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')).join('')}`;
      input.addEventListener('change', () => {
        const hex = input.value.slice(1);
        finish({ value: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',') });
      });
      input.addEventListener('cancel', () => finish(undefined));
      input.click();
      return;
    }
    finish(undefined);
  });
}

/** \![close,dialog,ID]。__SYSTEM_ALL_DIALOG__ か省略で全部 */
export function closeSystemDialogs(id?: string): void {
  for (const [key, close] of [...openDialogs]) if (!id || id === '__SYSTEM_ALL_DIALOG__' || key === id) close();
}
