import type { Descript } from '../package/descript';
import type { Shell } from '../shell/shell';
import type { PackageMeta } from '../vfs/storage';
import { ghostListProperty, type GhostListEntry } from './ghostlist';
import { settings } from './settings';

/**
 * プロパティシステム (ukadoc の list/propertysystem)。%property[…] と \![get,property] / \![set,property] から使う。
 * ブラウザでは分からない値 (CPU の名前・ディスクなど) は空か -1 にする。
 */

export interface ScopeInfo {
  surface: number;
  /** 実行中のアニメーション */
  animations: number[];
  defaultSurface: number;
  /** デスクトップ座標の矩形 */
  rect: { left: number; top: number; width: number; height: number };
  /** 基準点 (普通は中央下) のデスクトップ座標 */
  base: { x: number; y: number };
  scaling: number;
  name: string;
}

export interface BalloonInfo {
  id: number;
  count: number;
  rect: { left: number; top: number; width: number; height: number };
  valid: { width: number; height: number };
  basepos: { x: number; y: number };
  vertical: boolean;
  lineHeight: number;
  charWidth: number;
  scaling: number;
}

export interface SoundInfo {
  name: string;
  playing: boolean;
  paused: boolean;
  loop: boolean;
  volume: number;
  balance: number;
  duration: number;
  position: number;
}

export interface LogEntry {
  type: string;
  name: string;
  value: string;
  time: Date;
}

/** プロパティを読み書きするのに要るゴースト側のもの (Ghost.propertyHost が作る) */
export interface PropertyHost {
  name: string;
  sakuraName: string;
  keroName: string;
  path: string;
  descript: Descript;
  shell: Shell;
  shellDirs: string[];
  shellOf(dir: string): Shell;
  balloonName: string;
  balloonPath: string;
  balloonDescript?: Descript;
  status: string;
  userName: string;
  desktop: { width: number; height: number };
  idleSeconds: number;
  installed: PackageMeta[];
  active: GhostListEntry[];
  scopes: number[];
  scope(id: number): ScopeInfo | undefined;
  balloon(id: number): BalloonInfo | undefined;
  sounds: SoundInfo[];
  sticky: string;
  zorder: string;
  /** \![set,property] で書いた値 (mousecursor・シェルのメニュー表示など) */
  saved: Record<string, string>;
  logs(kind: string): LogEntry[];
  /** 書き込み */
  setSurface(scope: number, id: string): void;
  playAnimation(scope: number, id: number): void;
  setDefaultSurface(scope: number, id: number): void;
  setSticky(text: string): void;
  setZorder(text: string): void;
  setSound(name: string, key: string, value: string): boolean;
  save(): void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const rectText = (r: { left: number; top: number; width: number; height: number }) =>
  [r.left, r.top, r.left + r.width, r.top + r.height].map((v) => Math.round(v)).join(',');

/** 汎用プロパティ名 (descript のあるもの) */
function generic(field: string, e: { name: string; path: string; sakuraName?: string; keroName?: string; descript?: { str(k: string): string } }, index: number): string {
  switch (field) {
    case 'name':
      return e.name;
    case 'sakuraname':
      return e.sakuraName ?? '';
    case 'keroname':
      return e.keroName ?? '';
    case 'path':
      return e.path;
    case 'index':
      return String(index);
    case 'craftman':
    case 'craftmanw':
    case 'craftmanurl':
    case 'homeurl':
      return e.descript?.str(field) ?? '';
    case 'thumbnail':
      return '';
    default:
      return '';
  }
}

/** 「名前(…)」「.index(N)」「.current」で探すリストのプロパティ */
function listProperty<T extends { name: string; path: string }>(
  p: string,
  prefix: string,
  items: T[],
  current: number,
  field: (item: T, index: number, name: string) => string,
): string | undefined {
  if (p === `${prefix}.count`) return String(items.length);
  const esc = prefix.replace(/\./g, '\\.');
  const m = new RegExp(`^${esc}(?:\\((.*)\\)|\\.index\\((\\d+)\\)|\\.(current))\\.([\\w.]+)$`).exec(p);
  if (!m) return undefined;
  const [, key, index, cur, name] = m;
  const at = index !== undefined ? Number(index) : cur ? current : items.findIndex((e) => [e.name, e.path].some((v) => v.toLowerCase() === key.trim()));
  const item = items[at];
  return item ? field(item, at, name) : '';
}

/** 使用率 (rateofuselist)。起動時間の長い順 */
export function rateOfUse(installed: PackageMeta[]): { meta: PackageMeta; boots: number; minutes: number; percent: number }[] {
  const rows = installed
    .filter((p) => p.kind === 'ghost')
    .map((meta) => {
      const st = settings.ghosts[meta.key];
      return { meta, boots: st?.bootCount ?? 0, minutes: Math.floor((st?.totalSeconds ?? 0) / 60) };
    });
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  return rows.map((r) => ({ ...r, percent: total ? (r.minutes * 100) / total : 0 })).sort((a, b) => b.minutes - a.minutes || b.boots - a.boots);
}

function systemProperty(p: string, h: PropertyHost): string | undefined {
  const now = new Date();
  const fixed: Record<string, string | number> = {
    'system.year': now.getFullYear(),
    'system.month': now.getMonth() + 1,
    'system.day': now.getDate(),
    'system.hour': now.getHours(),
    'system.minute': now.getMinutes(),
    'system.second': now.getSeconds(),
    'system.millisecond': now.getMilliseconds(),
    'system.dayofweek': now.getDay(),
    'system.os.type': 'Web',
    'system.os.arch': '',
    'system.os.name': typeof navigator === 'object' ? navigator.userAgent : '',
    'system.os.version': '',
    'system.os.build': '',
    'system.os.parenttype': '',
    'system.os.parentname': '',
    'system.os.locale': typeof navigator === 'object' ? navigator.language : '',
    'system.os.locale.language': typeof navigator === 'object' ? navigator.language.split('-')[0] : '',
    'system.os.locale.country': typeof navigator === 'object' ? (navigator.language.split('-')[1] ?? '') : '',
    'system.os.timezone.offset': now.getTimezoneOffset(),
    'system.os.dst': 0,
    'system.os.uptime': Math.floor(performance.now() / 1000),
    'system.os.unixtime': Math.floor(now.getTime() / 1000),
    'system.os.idletime': h.idleSeconds,
    'system.cpu.load': -1,
    'system.cpu.num': typeof navigator === 'object' ? (navigator.hardwareConcurrency ?? 1) : 1,
    'system.cpu.vendor': '',
    'system.cpu.name': '',
    'system.cpu.clock': -1,
    'system.cpu.features': '',
    'system.memory.load': -1,
    'system.memory.phyt': Math.round(((navigator as { deviceMemory?: number }).deviceMemory ?? 0) * 1024) || -1,
    'system.memory.phya': -1,
    'system.monitor.count': 1,
    'system.power.source': 'unknown',
    'system.power.battery.percent': -1,
    'system.power.battery.lifetime': -1,
    'system.power.battery.flag': 'unknown',
    'system.disk.count': 0,
    'system.network.status': typeof navigator === 'object' && navigator.onLine === false ? 'offline' : 'online',
    'system.network.ipaddress': '',
    'system.network.type': (navigator as { connection?: { type?: string } }).connection?.type ?? 'unknown',
    'system.network.cost': 'unknown',
    'system.network.downlink': (navigator as { connection?: { downlink?: number } }).connection?.downlink ?? -1,
    'system.network.downlink.estimate': (navigator as { connection?: { downlink?: number } }).connection?.downlink ?? -1,
    'system.dnd.mode': 'normal',
    'system.cursor.pos': '',
  };
  if (p in fixed) return String(fixed[p]);
  if (p === 'system.theme.app.mode' || p === 'system.theme.os.mode') {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const m = /^system\.monitor\.index\((\d+)\)\.(work|rect|bpp|dpi|primary)$/.exec(p);
  if (m) {
    if (m[1] !== '0') return '';
    if (m[2] === 'bpp') return String(screen.colorDepth ?? 24);
    if (m[2] === 'dpi') return String(Math.round(96 * (window.devicePixelRatio || 1)));
    if (m[2] === 'primary') return '1';
    return `0,0,${h.desktop.width},${h.desktop.height}`;
  }
  return undefined;
}

function scopeProperty(p: string, h: PropertyHost): string | undefined {
  if (p === 'currentghost.scope.count') return String(Math.max(2, ...h.scopes.map((s) => s + 1)));
  const m = /^currentghost\.scope\((\d+)\)\.(.+)$/.exec(p);
  if (!m) return undefined;
  const id = Number(m[1]);
  const field = m[2];
  const s = h.scope(id);
  if (field === 'name') return id === 0 ? h.sakuraName : id === 1 ? h.keroName : h.descript.str(`char${id}.name`);
  if (!s) return '';
  const sm = /^surface\((-?\d+)\)\.rect$/.exec(field);
  if (sm) return rectText(s.rect);
  switch (field) {
    case 'surface.num':
      return String(s.surface);
    case 'animation.num':
      return s.animations.join(',');
    case 'seriko.defaultsurface':
      return String(s.defaultSurface);
    case 'surface.x':
      return String(Math.round(s.rect.left));
    case 'surface.y':
      return String(Math.round(s.rect.top));
    case 'x':
      return String(Math.round(s.base.x));
    case 'y':
      return String(Math.round(s.base.y));
    case 'rect':
      return rectText(s.rect);
    case 'scaling':
      return String(Math.round(s.scaling * 10000) / 100);
    case 'currentmonitor.work':
    case 'currentmonitor.rect':
      return `0,0,${h.desktop.width},${h.desktop.height}`;
    case 'currentmonitor.bpp':
      return String(screen.colorDepth ?? 24);
    case 'currentmonitor.dpi':
      return String(Math.round(96 * (window.devicePixelRatio || 1)));
    case 'currentmonitor.primary':
      return '1';
  }
  return '';
}

function balloonProperty(p: string, h: PropertyHost): string | undefined {
  const m = /^currentghost\.balloon\.scope\((\d+)\)\.(.+)$/.exec(p);
  if (!m) return undefined;
  const b = h.balloon(Number(m[1]));
  if (!b) return '';
  const lines = (height: number) => String(Math.max(1, Math.floor(height / Math.max(1, b.lineHeight))));
  switch (m[2]) {
    case 'count':
      return String(b.count);
    case 'num':
      return String(b.id);
    case 'x':
      return String(Math.round(b.rect.left));
    case 'y':
      return String(Math.round(b.rect.top));
    case 'rect':
      return rectText(b.rect);
    case 'validwidth':
      return String(Math.round(b.valid.width));
    case 'validwidth.initial':
      return String(Math.round(b.valid.width));
    case 'validheight':
      return String(Math.round(b.valid.height));
    case 'validheight.initial':
      return String(Math.round(b.valid.height));
    case 'lines':
    case 'lines.initial':
      return lines(b.valid.height);
    case 'basepos.x':
      return String(Math.round(b.basepos.x));
    case 'basepos.y':
      return String(Math.round(b.basepos.y));
    case 'char_width':
      return String(Math.round(b.charWidth));
    case 'scaling':
      return String(Math.round(b.scaling * 10000) / 100);
    case 'vertical':
      return b.vertical ? '1' : '0';
    case 'background.color':
      return '255,255,255';
  }
  return '';
}

/** seriko.cursor / seriko.tooltip (シェルの定義を直接読み書きする) */
function serikoProperty(p: string, h: PropertyHost, value?: string): string | undefined {
  const prefix = (id: number) => (id === 0 ? 'sakura' : id === 1 ? 'kero' : `char${id}`);
  let m = /^currentghost\.seriko\.cursor\.scope\((\d+)\)\.mouse(up|down|hover|wheel|rightdown)list(?:\((.*)\)|\.index\((\d+)\))?\.(path|name|count)$/.exec(p);
  if (m) {
    const key = prefix(Number(m[1]));
    const state = `mouse${m[2]}`;
    const all = h.shell.surfaces.cursors.get(key) ?? [];
    const rules = all.filter((r) => r.state === state);
    if (m[5] === 'count') return String(rules.length);
    const rule = m[4] !== undefined ? rules[Number(m[4])] : rules.find((r) => r.collision.toLowerCase() === (m![3] ?? '').toLowerCase());
    if (value === undefined) return rule ? (m[5] === 'path' ? rule.file : rule.collision) : '';
    if (m[5] !== 'path') return undefined;
    if (rule) {
      if (value) rule.file = value;
      else all.splice(all.indexOf(rule), 1);
    } else if (value && m[3]) {
      all.push({ state, collision: m[3], file: value });
      h.shell.surfaces.cursors.set(key, all);
    }
    return value;
  }
  m = /^currentghost\.seriko\.tooltip\.scope\((\d+)\)\.textlist(?:\((.*)\)|\.index\((\d+)\))?\.(text|name|count)$/.exec(p);
  if (m) {
    const key = prefix(Number(m[1]));
    const map = h.shell.surfaces.tooltips.get(key) ?? new Map<string, string>();
    const entries = [...map];
    if (m[4] === 'count') return String(entries.length);
    const entry = m[3] !== undefined ? entries[Number(m[3])] : entries.find(([n]) => n.toLowerCase() === (m![2] ?? '').toLowerCase());
    if (value === undefined) return entry ? (m[4] === 'text' ? entry[1] : entry[0]) : '';
    if (m[4] !== 'text') return undefined;
    const name = entry?.[0] ?? m[2];
    if (!name) return undefined;
    if (value) map.set(name, value);
    else map.delete(name);
    h.shell.surfaces.tooltips.set(key, map);
    return value;
  }
  return undefined;
}

function soundProperty(p: string, h: PropertyHost): string | undefined {
  if (p === 'currentghost.sound.count') return String(h.sounds.length);
  const m = /^currentghost\.sound(?:\((.*)\)|\.index\((\d+)\))\.(\w+)$/.exec(p);
  if (!m) return undefined;
  const list = [...h.sounds].reverse();
  const s = m[2] !== undefined ? list[Number(m[2])] : list.find((x) => x.name.toLowerCase() === (m[1] ?? '').toLowerCase());
  if (!s) return '';
  switch (m[3]) {
    case 'name':
    case 'path':
      return s.name;
    case 'playing':
      return s.playing ? '1' : '0';
    case 'pause':
    case 'paused':
      return s.paused ? '1' : '0';
    case 'loop':
      return s.loop ? '1' : '0';
    case 'volume':
      return String(s.volume);
    case 'balance':
      return String(s.balance);
    case 'length':
    case 'duration':
      return String(Math.round(s.duration * 1000));
    case 'position':
    case 'seektime':
      return String(Math.round(s.position * 1000));
  }
  return '';
}

function logProperty(p: string, h: PropertyHost): string | undefined {
  const m = /^developer\.log\.(\w+)(?:\((.*?)\))?(?:\.index\((\d+)\))?\.(count|type|name|value|time)$/.exec(p);
  if (!m) return undefined;
  let logs = [...h.logs(m[1])].reverse();
  if (m[2] !== undefined) logs = logs.filter((l) => l.name.toLowerCase() === m[2].toLowerCase());
  if (m[4] === 'count') return String(logs.length);
  const l = logs[Number(m[3] ?? 0)];
  if (!l) return '';
  if (m[4] === 'time') return `${l.time.getFullYear()}/${pad2(l.time.getMonth() + 1)}/${pad2(l.time.getDate())} ${pad2(l.time.getHours())}:${pad2(l.time.getMinutes())}`;
  return l[m[4] as 'type' | 'name' | 'value'];
}

/**
 * プロパティ名を小文字にし、scope1・index0 のような括弧の無い番号を scope(1)・index(0) にする。
 * 華和梨は ( ) で囲んだ単語の中の括弧を消すので、『CLDSP2+』などの currentghost.scope(1).surface.num は scope1 として届く
 */
function canonicalPath(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/\.(scope|index)(\d+)(?=\.|$)/g, '.$1($2)');
}

/** プロパティを読む。知らない名前は空文字列 */
export function readProperty(path: string, h: PropertyHost): string {
  const p = canonicalPath(path);
  const sys = systemProperty(p, h);
  if (sys !== undefined) return sys;
  const ghosts = h.installed.filter((m) => m.kind === 'ghost');
  const balloons = h.installed.filter((m) => m.kind === 'balloon');
  const fixed: Record<string, string | number> = {
    'baseware.name': 'Engawa',
    'baseware.windowmode': 'shared',
    'currentghost.name': h.name,
    'currentghost.sakuraname': h.sakuraName,
    'currentghost.keroname': h.keroName,
    'currentghost.craftman': h.descript.str('craftman'),
    'currentghost.craftmanw': h.descript.str('craftmanw'),
    'currentghost.craftmanurl': h.descript.str('craftmanurl'),
    'currentghost.homeurl': h.descript.str('homeurl'),
    'currentghost.path': h.path,
    'currentghost.username': h.userName,
    'currentghost.index': ghosts.findIndex((g) => g.key === h.path),
    'currentghost.thumbnail': '',
    'currentghost.status': h.status,
    'currentghost.balloon.name': h.balloonName,
    'currentghost.balloon.path': h.balloonPath,
    'currentghost.balloon.craftman': h.balloonDescript?.str('craftman') ?? '',
    'currentghost.balloon.craftmanw': h.balloonDescript?.str('craftmanw') ?? '',
    'currentghost.balloon.craftmanurl': h.balloonDescript?.str('craftmanurl') ?? '',
    'currentghost.balloon.homeurl': h.balloonDescript?.str('homeurl') ?? '',
    'currentghost.balloon.count': 1,
    'currentghost.seriko.sticky-window': h.sticky,
    'currentghost.seriko.zorder': h.zorder,
    'history.ghost.count': (settings.history?.ghost ?? []).length,
    'history.balloon.count': (settings.history?.balloon ?? []).length,
    'history.headline.count': 0,
    'history.plugin.count': 0,
  };
  if (p in fixed) return String(fixed[p]);
  if (p.startsWith('currentghost.mousecursor') || p.startsWith('currentghost.balloon.mousecursor')) return h.saved[p] ?? '';
  if (p === 'currentghost.seriko.surfacelist.all' || p === 'currentghost.seriko.surfacelist.defined') {
    const ids = new Set<number>(h.shell.surfaces.surfaces.keys());
    if (p.endsWith('.all')) {
      for (const f of h.shell.files.list()) {
        const m = /^surface(\d+)\.png$/i.exec(f);
        if (m) ids.add(Number(m[1]));
      }
    }
    return [...ids].sort((a, b) => a - b).join(',');
  }
  for (const fn of [scopeProperty, balloonProperty, soundProperty, logProperty]) {
    const v = fn(p, h);
    if (v !== undefined) return v;
  }
  const seriko = serikoProperty(p, h);
  if (seriko !== undefined) return seriko;
  const gl = ghostListProperty(
    p,
    ghosts.map((g) => h.active.find((a) => a.path === g.key) ?? { name: g.name, sakuraName: g.sakuraName ?? '', path: g.key }),
    h.active,
    h.path,
  );
  if (gl !== undefined) return gl;
  // シェル
  const shells = h.shellDirs.map((d) => ({ name: h.shellOf(d).name, path: `shell/${d}`, dir: d }));
  const shell = listProperty(p, 'currentghost.shelllist', shells, h.shellDirs.indexOf(h.shell.dir), (s, i, f) => {
    if (f === 'menu') return h.saved[`shell:${s.dir}:menu`] ?? h.shellOf(s.dir).descript.str('menu');
    const d = h.shellOf(s.dir).descript;
    return generic(f, { ...s, descript: d }, i);
  });
  if (shell !== undefined) return shell;
  // ヘッドライン・プラグイン (保存してあるだけで動かないが、一覧は答える)
  for (const kind of ['headline', 'plugin'] as const) {
    const items = h.installed.filter((m) => m.kind === kind).map((m) => ({ name: m.name, path: m.key }));
    const v = listProperty(p, `${kind}list`, items, -1, (e, i, f) => generic(f, e, i));
    if (v !== undefined) return v;
  }
  const bl = listProperty(
    p,
    'balloonlist',
    balloons.map((b) => ({ name: b.name, path: b.key })),
    balloons.findIndex((b) => b.key === h.balloonPath),
    (b, i, f) => generic(f, b, i),
  );
  if (bl !== undefined) return bl;
  // 最近使ったもの (キーの一覧)
  for (const kind of ['ghost', 'balloon'] as const) {
    const keys = settings.history?.[kind] ?? [];
    const items = keys.map((k) => h.installed.find((m) => m.key === k)).filter((m): m is PackageMeta => !!m).map((m) => ({ name: m.name, path: m.key, sakuraName: m.sakuraName }));
    const v = listProperty(p, `history.${kind}`, items, 0, (e, i, f) => generic(f, e, i));
    if (v !== undefined) return v;
  }
  // 使用率
  const m = /^rateofuselist(?:\((.*)\)|\.index\((\d+)\))\.(\w+)$/.exec(p);
  if (m) {
    const rows = rateOfUse(h.installed);
    const r = m[2] !== undefined ? rows[Number(m[2])] : rows.find((x) => x.meta.name.toLowerCase() === (m[1] ?? '').toLowerCase());
    if (!r) return '';
    switch (m[3]) {
      case 'name':
        return r.meta.name;
      case 'sakuraname':
        return r.meta.sakuraName ?? '';
      case 'keroname':
        return h.active.find((a) => a.path === r.meta.key)?.keroName ?? '';
      case 'boottime':
      case 'boottimeweekly':
      case 'boottimemonthly':
        return String(r.boots);
      case 'bootminute':
      case 'bootminuteweekly':
      case 'bootminutemonthly':
        return String(r.minutes);
      case 'percent':
      case 'percentweekly':
      case 'percentmonthly':
        return r.percent.toFixed(2);
    }
    return '';
  }
  return '';
}

/** プロパティを書く ([SET有効] のもの)。書けたら true */
export function writeProperty(path: string, value: string, h: PropertyHost): boolean {
  const p = canonicalPath(path);
  let m = /^currentghost\.scope\((\d+)\)\.(surface\.num|animation\.num|seriko\.defaultsurface)$/.exec(p);
  if (m) {
    const scope = Number(m[1]);
    if (m[2] === 'surface.num') h.setSurface(scope, value);
    else if (m[2] === 'animation.num') value.split(',').forEach((v) => h.playAnimation(scope, Number(v)));
    else h.setDefaultSurface(scope, Number(value));
    return true;
  }
  if (p.startsWith('currentghost.mousecursor') || p.startsWith('currentghost.balloon.mousecursor')) {
    if (value) h.saved[p] = value;
    else delete h.saved[p];
    h.save();
    return true;
  }
  if (p === 'currentghost.seriko.sticky-window') {
    h.setSticky(value);
    return true;
  }
  if (p === 'currentghost.seriko.zorder') {
    h.setZorder(value);
    return true;
  }
  if (serikoProperty(p, h, value) !== undefined) return true;
  m = /^currentghost\.shelllist(?:\((.*)\)|\.index\((\d+)\)|\.(current))\.menu$/.exec(p);
  if (m) {
    const dir =
      m[2] !== undefined
        ? h.shellDirs[Number(m[2])]
        : m[3]
          ? h.shell.dir
          : h.shellDirs.find((d) => d.toLowerCase() === m![1].trim() || `shell/${d}`.toLowerCase() === m![1].trim() || h.shellOf(d).name.toLowerCase() === m![1].trim());
    if (!dir) return false;
    h.saved[`shell:${dir}:menu`] = value.trim().toLowerCase() === 'hidden' ? 'hidden' : '';
    h.save();
    return true;
  }
  m = /^currentghost\.sound(?:\((.*)\)|\.index\((\d+)\))\.(\w+)$/.exec(p);
  if (m) {
    const list = [...h.sounds].reverse();
    const s = m[2] !== undefined ? list[Number(m[2])] : list.find((x) => x.name.toLowerCase() === (m![1] ?? '').toLowerCase());
    return !!s && h.setSound(s.name, m[3], value);
  }
  return false;
}
