import type { Ghost, ToolName } from '../ghost/ghost';
import { rateOfUse, type LogEntry } from '../ghost/properties';
import { decodeText } from '../util/text';
import { filesFromZip } from '../vfs/archive';
import type { PackageMeta } from '../vfs/storage';
import { t } from '../i18n';
import { button, showPanel, showText } from './dialogs';
import { el } from './dom';

/**
 * ベースウェアの道具 (\![open,…] とメニューから開くもの): readme・使用率グラフ・開発用パレット・サーフェステスト・
 * スクリプトログ・エラーログ・SHIORI リクエスト・AI グラフ・画像ビューア・アーカイブビューア。
 */

export interface ToolHost {
  installed(): PackageMeta[];
  logs(kind: string): LogEntry[];
  openOptions(): void;
  openHelp(): void;
  openPackages(): void;
  toast(message: string): void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const time = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** ゴーストのフォルダの文書 (readme.txt など)。文字コードは charset 行か自動判定 */
function ghostText(g: Ghost, names: string[]): string | undefined {
  for (const n of names) {
    const data = g.files.get(n) ?? g.files.get(`ghost/master/${n}`);
    if (data) return decodeText(data);
  }
  return undefined;
}

export function hasReadme(g: Ghost): boolean {
  return ghostText(g, [g.descript.str('readme') || 'readme.txt', 'readme.txt']) !== undefined;
}

export function openTool(host: ToolHost, g: Ghost, tool: ToolName, args: string[]): void {
  switch (tool) {
    case 'readme': {
      const text = ghostText(g, [g.descript.str('readme') || 'readme.txt', 'readme.txt']);
      if (text) showText(`${g.name} - readme`, text);
      else host.toast(t('tools.noReadme', { name: g.name }));
      return;
    }
    case 'terms': {
      const text = ghostText(g, [g.descript.str('terms') || 'terms.txt', 'terms.txt']);
      // 利用条件ダイアログ: 受諾・拒否でゴーストに知らせる (右上の閉じるでは何も送らない)
      if (text) {
        showText(t('tools.terms', { name: g.name }), text, {
          actions: [
            { label: t('tools.termsDecline'), run: () => void g.raise('OnGhostTermsDecline') },
            { label: t('tools.termsAccept'), run: () => void g.raise('OnGhostTermsAccept') },
          ],
        });
      } else host.toast(t('tools.noTerms', { name: g.name }));
      return;
    }
    case 'help':
      host.openHelp();
      return;
    case 'configurationdialog':
      host.openOptions();
      return;
    case 'ghostexplorer':
    case 'shellexplorer':
    case 'balloonexplorer':
    case 'pluginexplorer':
    case 'headlinesensorexplorer':
      host.openPackages();
      return;
    case 'dressupexplorer':
      dressup(g);
      return;
    case 'rateofusegraph':
    case 'rateofusegraphballoon':
    case 'rateofusegraphtotal':
      usageGraph(host);
      return;
    case 'developer':
      developer(host, g);
      return;
    case 'surfacetest':
      surfaceTest(g);
      return;
    case 'shiorirequest':
      shioriRequest(g);
      return;
    case 'errorlog':
      logView(host, 'error', t('tools.errorLog'));
      return;
    case 'backlogviewer':
      logView(host, 'script', t('tools.scriptLog'));
      return;
    case 'aigraph':
      void aiGraph(g);
      return;
    case 'addressbar': {
      const url = window.prompt(t('tools.openUrl'));
      if (url) g.openUrl(url);
      return;
    }
    case 'pictureviewer':
      picture(host, g, args[0]);
      return;
    case 'archiveviewer':
      archive(host, g, args[0]);
      return;
    case 'sendbox':
      sendBox(g);
      return;
  }
}

/** 着せ替えの一覧 (チェックで着る・脱ぐ) */
function dressup(g: Ghost): void {
  const list = el('div', { className: 'tool-list' });
  for (const scope of [0, 1, 2, 3]) {
    for (const b of g.bindGroups(scope)) {
      const box = el('input', { type: 'checkbox', checked: b.enabled, className: 'check-input' });
      box.addEventListener('change', () => g.setDressup(scope, b.id, box.checked));
      list.appendChild(el('label', { className: 'tool-row' }, box, ` \\${scope} ${b.category} / ${b.part}`));
    }
  }
  if (!list.childElementCount) list.textContent = t('tools.noDressup');
  showPanel(t('tools.dressup'), list);
}

/** 使用率 (使ってるぞグラフ) */
function usageGraph(host: ToolHost): void {
  const rows = rateOfUse(host.installed());
  const table = el('table', { className: 'tool-table' });
  table.appendChild(el('tr', {}, el('th', {}, t('tools.usageGhost')), el('th', {}, t('tools.usageBoots')), el('th', {}, t('tools.usageTime')), el('th', {}, t('tools.usageShare'))));
  for (const r of rows) {
    const bar = el('span', { className: 'usage-bar' });
    bar.style.width = `${Math.max(1, r.percent)}%`;
    table.appendChild(
      el('tr', {}, el('td', {}, r.meta.name), el('td', {}, String(r.boots)), el('td', {}, t('tools.usageDuration', { hours: Math.floor(r.minutes / 60), minutes: r.minutes % 60 })), el('td', { className: 'usage-cell' }, bar, ` ${r.percent.toFixed(1)}%`)),
    );
  }
  showPanel(t('tools.usage'), table);
}

/** 開発用パレット: スクリプトを送る・イベントを送る・当たり判定の表示・読み直し */
function developer(host: ToolHost, g: Ghost): void {
  const box = el('div', { className: 'tool-stack' });
  const script = el('textarea', { className: 'text-input text-area', rows: 4, placeholder: t('tools.scriptSample') });
  const send = button(t('tools.playScript'), 'primary', () => {
    if (script.value.trim()) void g.playScript(script.value.trim(), { kinds: ['owned'] });
  });
  const event = el('input', { className: 'text-input', placeholder: 'OnBoot' });
  const refs = el('input', { className: 'text-input', placeholder: t('tools.references') });
  const raise = button(t('tools.raiseEvent'), 'secondary', () => {
    if (event.value.trim()) void g.raise(event.value.trim(), refs.value ? refs.value.split(',') : []);
  });
  let collisions = false;
  const toggle = button(t('tools.showCollision'), 'secondary', () => {
    collisions = !collisions;
    void g.command([collisions ? 'enter' : 'leave', 'collisionmode'], 0);
    toggle.textContent = collisions ? t('tools.hideCollision') : t('tools.showCollision');
  });
  const reload = el(
    'div',
    { className: 'tool-buttons' },
    button(t('tools.reloadGhost'), 'secondary', () => void g.command(['reload', 'ghost'], 0)),
    button(t('tools.reloadShiori'), 'secondary', () => void g.command(['reload', 'shiori'], 0)),
    button(t('tools.reloadShell'), 'secondary', () => void g.command(['reload', 'shell'], 0)),
    button(t('tools.makeUpdates'), 'secondary', () => {
      void g.command(['execute', 'createupdatedata'], 0);
      host.toast(t('tools.madeUpdates'));
    }),
    button(t('tools.makeNar'), 'secondary', () => void g.command(['execute', 'createnar'], 0)),
  );
  const status = el('p', { className: 'dialog-status' }, t('tools.status', { status: g.status() || t('tools.none') }));
  box.append(el('label', {}, t('tools.script')), script, send, el('label', {}, t('tools.event')), event, refs, raise, toggle, reload, status);
  showPanel(t('tools.developer', { name: g.name }), box, () => {
    if (collisions) void g.command(['leave', 'collisionmode'], 0);
  });
}

/** スクリプトを送るボックス (SSP の Script Input)。送ったものは履歴から選び直せる */
const sentScripts: string[] = [];

function sendBox(g: Ghost): void {
  const area = el('textarea', { className: 'text-input text-area', rows: 3, placeholder: t('tools.sendSample') });
  const history = el('select', { className: 'text-input' }, el('option', { value: '' }, t('tools.sentBefore')));
  const refresh = () => {
    history.replaceChildren(el('option', { value: '' }, t('tools.sentBefore')), ...sentScripts.map((s) => el('option', { value: s }, s.slice(0, 60))));
  };
  refresh();
  history.addEventListener('change', () => {
    if (history.value) area.value = history.value;
  });
  const send = button(t('tools.send'), 'primary', () => {
    const script = area.value.trim();
    if (!script) return;
    void g.playScript(script, { kinds: ['owned'] });
    const at = sentScripts.indexOf(script);
    if (at >= 0) sentScripts.splice(at, 1);
    sentScripts.unshift(script);
    sentScripts.splice(20);
    refresh();
  });
  // Ctrl+Enter で送る
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send.click();
    }
  });
  showPanel(t('tools.sendScript', { name: g.name }), el('div', { className: 'tool-stack' }, area, history, send));
  area.focus();
}

/** サーフェステスト: サーフェスの一覧から選んで出す */
function surfaceTest(g: Ghost): void {
  const scope = el('select', { className: 'text-input' });
  for (const [v, label] of [
    ['0', t('tools.scopeSakura')],
    ['1', t('tools.scopeKero')],
    ['2', '\\p[2]'],
    ['3', '\\p[3]'],
  ]) scope.appendChild(el('option', { value: v }, label));
  const list = el('div', { className: 'surface-grid' });
  const ids = g.property('currentghost.seriko.surfacelist.all').split(',').filter(Boolean);
  for (const id of ids) {
    list.appendChild(button(id, 'secondary', () => void g.setSurface(Number(scope.value), id)));
  }
  showPanel(t('tools.surfaceTest', { name: g.shell.name }), el('div', { className: 'tool-stack' }, scope, list));
}

/** SHIORI に直接リクエストを送って、返事を見る */
function shioriRequest(g: Ghost): void {
  const id = el('input', { className: 'text-input', placeholder: t('tools.requestId') });
  const refs = el('input', { className: 'text-input', placeholder: t('tools.references') });
  const method = el('select', { className: 'text-input' }, el('option', { value: 'GET' }, 'GET'), el('option', { value: 'NOTIFY' }, 'NOTIFY'));
  const out = el('pre', { className: 'license-text tool-output' });
  const send = button(t('tools.send'), 'primary', async () => {
    const v = await g.request(method.value as 'GET' | 'NOTIFY', id.value.trim(), refs.value ? refs.value.split(',') : []);
    out.textContent = v ?? t('tools.noValue');
  });
  showPanel(t('tools.shioriRequest'), el('div', { className: 'tool-stack' }, method, id, refs, send, out));
}

/** ログ (スクリプト・エラー・リクエスト)。新しいものが下 */
function logView(host: ToolHost, kind: string, title: string): void {
  const logs = host.logs(kind);
  const text = logs.map((l) => `[${time(l.time)}] ${l.name}: ${l.value}`).join('\n') || t('tools.logEmpty');
  showText(title, text);
}

/** AI グラフ (getaistate / getaistateex のレーダーチャート) */
async function aiGraph(g: Ghost): Promise<void> {
  const graphs = await g.aiState();
  const box = el('div', { className: 'tool-stack' });
  if (!graphs.length) box.textContent = t('tools.noAiGraph');
  for (const graph of graphs) {
    const size = 280;
    const canvas = el('canvas', { width: size, height: size, className: 'ai-graph' });
    const ctx = canvas.getContext('2d');
    const n = graph.values.length;
    if (ctx && n >= 3) {
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 40;
      const style = getComputedStyle(document.documentElement);
      const fg = style.getPropertyValue('--window-text').trim() || '#000';
      const accent = style.getPropertyValue('--accent').trim() || '#36c';
      const point = (i: number, r: number) => [cx + r * Math.sin((i / n) * Math.PI * 2), cy - r * Math.cos((i / n) * Math.PI * 2)] as const;
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.3;
      for (const k of [0.25, 0.5, 0.75, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) ctx.lineTo(...point(i % n, radius * k));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const max = (i: number) => graph.max[i] || Math.max(...graph.values.map((v, j) => v + (graph.adds[j] ?? 0)), 1);
      const shape = (extra: boolean) => {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const j = i % n;
          const v = graph.values[j] + (extra ? (graph.adds[j] ?? 0) : 0);
          ctx.lineTo(...point(j, (radius * Math.max(0, v)) / max(j)));
        }
      };
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.2;
      shape(true);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      shape(false);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = fg;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      graph.labels.forEach((label, i) => {
        const [x, y] = point(i, radius + 18);
        ctx.fillText(`${label} ${graph.values[i] ?? ''}`, x, y + 4);
      });
    }
    box.appendChild(canvas);
  }
  showPanel(t('tools.aiGraph', { name: g.name }), box);
}

/** 画像ビューア (ゴーストのフォルダの画像) */
function picture(host: ToolHost, g: Ghost, file?: string): void {
  const url = file ? g.fileUrl(file) : undefined;
  if (!url) {
    host.toast(file ? t('toast.notFound', { name: file }) : t('tools.noPicture'));
    return;
  }
  showPanel(file ?? t('tools.picture'), el('img', { src: url, alt: file ?? '', className: 'tool-picture' }));
}

/** アーカイブビューア (zip / nar の中身の一覧) */
function archive(host: ToolHost, g: Ghost, file?: string): void {
  const data = file ? (g.files.get(file) ?? g.files.get(`ghost/master/${file}`)) : undefined;
  if (!data) {
    host.toast(file ? t('toast.notFound', { name: file }) : t('tools.noArchive'));
    return;
  }
  try {
    const tree = filesFromZip(data);
    showText(file ?? t('tools.archive'), tree.list().map((p) => t('tools.archiveEntry', { path: p, size: tree.get(p)?.length ?? 0 })).join('\n'));
  } catch (e) {
    host.toast(t('tools.openFailed', { name: file ?? '', error: (e as Error).message }));
  }
}
