import { BalloonSkin } from '../balloon/skin';
import { Descript } from '../package/descript';
import { acceptNamesOf, InstallError, installFiles, type Installed, type InstallResult, type InstallTarget } from '../package/installer';
import { CharacterLayer } from '../shell/character-layer';
import { Shell } from '../shell/shell';
import { confirmDialog, InputBox, packageKindLabel, showHelp, showInfo, showLicenses, showOptions, showPackages, showText, Toasts } from '../ui/dialogs';
import { hasReadme, openTool, type ToolHost } from '../ui/tools';
import { networkUpdate, updateResultRefs, type UpdateSummary } from '../package/update';
import { licenseText } from '../ui/licenses';
import { el } from '../ui/dom';
import { menuSkin } from '../ui/menu-skin';
import { ContextMenu, type MenuItem } from '../ui/menu';
import { filesFromDirectoryEntry, filesFromFileList, filesFromZip } from '../vfs/archive';
import type { FileTree } from '../vfs/files';
import { decodeText } from '../util/text';
import {
  deletePackage,
  deletePackageFiles,
  isPersistent,
  listPackages,
  patchPackageMeta,
  readPackageFile,
  readPackageFiles,
  writePackageFile,
  type PackageMeta,
} from '../vfs/storage';
import {
  BASEWARE_NAME,
  BASEWARE_VERSION,
  Ghost,
  type BootMode,
  type GhostEnv,
  type GhostIdentity,
  type InputFilter,
  type InputKind,
  type InputRequest,
  type InputResult,
  type ToolName,
  type UpdateRequest,
} from './ghost';
import type { LogEntry } from './properties';
import { addHistory, saveSettings, saveSettingsNow, settings } from './settings';
import { EnvironmentEvents } from './environment';
import { handleSstp, type SstpHost } from './sstp';
import { PluginHost } from '../plugin/host';

// ビルドでは data: URL として index.html に埋め込まれる (file:// で開いても読めるように)
import SAMPLE_URL from '../assets/engawa.nar?url';
import README from '../../README.md?raw';
const ARCHIVE = /\.(nar|zip)$/i;
/** ログの種類ごとに残す数 */
const LOG_LIMIT = 200;
const COOKIE_KEY = 'engawa.sstp-cookies';

function loadCookies(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(localStorage.getItem(COOKIE_KEY) ?? '{}') as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

/** 入力ボックス1つ分の持ち主と種類 */
interface InputSlot {
  owner: Ghost;
  kind: InputKind;
  id?: string;
}

/** \![close,inputbox,ID] / \![close,communicatebox] がその入力ボックスに当たるか */
function matchesInput(slot: InputSlot, ghost: Ghost, filter?: InputFilter): boolean {
  if (slot.owner !== ghost) return false;
  if (!filter) return true;
  if (filter.kind === 'communicatebox' || filter.kind === 'teachbox') return slot.kind === filter.kind;
  return slot.kind === filter.kind && (!filter.id || filter.id === '__SYSTEM_ALL_INPUT__' || slot.id === filter.id);
}

/** ベースウェア本体。ゴーストの起動・切り替え、メニュー、インストールを受け持つ。 */
export class GhostManager implements GhostEnv {
  readonly ghosts: Ghost[] = [];
  readonly characters: CharacterLayer;
  private packages: PackageMeta[] = [];
  private current?: Ghost;
  private lastInput = Date.now();
  private readonly menu: ContextMenu;
  /** いま開いているメニューがトレイボタンから開いたものか (aria-expanded 用) */
  private menuFromTray = false;
  private readonly inputBox = new InputBox();
  /** 入力ボックスを開いているゴーストと、その入力が終わるまでの Promise */
  private openInput?: InputSlot & { done: Promise<unknown> };
  /** 別のゴーストの入力ボックスが閉じるのを待っている要求 (取り消されたら wake で起こす) */
  private readonly queuedInputs = new Set<InputSlot & { cancelled: boolean; wake: () => void }>();
  private readonly toasts: Toasts;
  private readonly balloons = new Map<string, Promise<BalloonSkin>>();
  private readonly emptyState: HTMLElement;
  private readonly emptyButton: HTMLButtonElement;
  private emptyAction: () => void = () => {};
  private readonly tray: HTMLButtonElement;
  /** 起動処理中のパッケージ (同じゴーストを二重に起動しないように) */
  private readonly booting = new Set<string>();
  /** スクリプト・エラー・リクエストのログ (開発用パレット・developer.log) */
  private readonly logStore = new Map<string, LogEntry[]>();
  /** \![wait,syncobject] の名前付き同期オブジェクト */
  private readonly syncObjects = new Map<string, { signaled: boolean; waiters: Set<() => void> }>();
  /** \![set,tasktrayicon] (ゴーストごと) */
  private readonly trayIcons = new Map<Ghost, { url?: string; text: string }>();
  /** 最後にインストールしたものの名前 (lastinstalled・%lastobjectname) */
  private readonly lastInstalledNames: Partial<Record<string, string>> = {};
  private readonly sstpCookies = loadCookies();
  /** ネットワーク・バッテリー・ゲームパッドなど、まわりの変化 */
  private readonly environment: EnvironmentEvents;
  /** プラグイン (PLUGIN/2.0) */
  readonly plugins: PluginHost;

  /**
   * embedded: よそのページに埋め込んで使う (ななろだのおためし起動など。src/embed.ts)。
   * サンプルのゴーストを入れず、自分では何も起動せず、ファイルのドロップも受けず、空のときの案内も出さない
   */
  constructor(
    readonly desktop: HTMLElement,
    private readonly overlay: HTMLElement,
    private readonly options: { embedded?: boolean } = {},
  ) {
    this.tray = overlay.querySelector<HTMLButtonElement>('.tray-button')!;
    this.characters = new CharacterLayer(desktop, (e) => this.openMenu(this.current, e.clientX, e.clientY));
    this.toasts = new Toasts(overlay, () => this.tray);
    this.menu = new ContextMenu(overlay);
    this.menu.onToggle = (open) => {
      if (!open) this.menuFromTray = false;
      this.tray.setAttribute('aria-expanded', String(open && this.menuFromTray));
    };
    this.emptyState = overlay.querySelector('.empty-state')!;
    this.emptyButton = this.emptyState.querySelector('button')!;
    this.emptyButton.addEventListener('click', () => this.emptyAction());
    this.environment = new EnvironmentEvents(
      () => this.ghosts,
      () => this.current,
      desktop,
    );
    this.plugins = new PluginHost({
      ghosts: () => this.ghosts,
      current: () => this.current,
      installed: () => this.packages,
      log: (name, text) => this.logPlugin(name, text),
      sstp: (request) => this.sstp(request, true),
    });
  }

  environmentNotices(ghost: Ghost): Promise<void> {
    return this.environment.bootNotices(ghost);
  }

  async init(): Promise<void> {
    this.bindGlobalEvents();
    this.startClock();
    const loop = (now: number) => {
      for (const g of this.ghosts) g.tick(now);
      this.environment.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.environment.start();
    window.setInterval(() => {
      this.environment.second();
      this.plugins.second();
    }, 1000);

    await this.refreshPackages();
    if (this.options.embedded) return;
    if (!(await isPersistent())) {
      this.toasts.show('このブラウザでは保存領域が使えないため、インストールしたものや設定はページを閉じると消えます', {
        duration: 12_000,
      });
    }
    if (!this.packages.some((p) => p.kind === 'ghost')) await this.installSample();
    await this.bootDefault();
    // アドレスに書かれた x-ukagaka-link (?x-ukagaka-link=… か #x-ukagaka-link:…) は、ゴーストが起きてから開く
    const link = new URLSearchParams(location.search).get('x-ukagaka-link') ?? (/^#(x-ukagaka-link:.*)$/i.exec(decodeURIComponent(location.hash))?.[1] ?? null);
    if (link) window.setTimeout(() => this.openUkagakaLink(link.startsWith('x-ukagaka-link:') ? link : `x-ukagaka-link:${link}`), 3000);
  }

  // ---------------------------------------------------------------- GhostEnv

  lastInputAt(): number {
    return this.lastInput;
  }

  others(self: Ghost): Ghost[] {
    return this.ghosts.filter((g) => g !== self && g.alive);
  }

  installed(): PackageMeta[] {
    return this.packages;
  }

  loadBalloon(key: string | null): Promise<BalloonSkin> {
    if (!key || !this.packages.some((p) => p.key === key)) return Promise.resolve(BalloonSkin.builtin());
    let p = this.balloons.get(key);
    if (!p) {
      const loading = readPackageFiles(key).then((files) => BalloonSkin.load(key, files));
      p = loading;
      this.balloons.set(key, loading);
      // 一度失敗しても次は読み直す
      loading.catch(() => {
        if (this.balloons.get(key) === loading) this.balloons.delete(key);
      });
    }
    return p.catch((e) => {
      const name = this.packages.find((m) => m.key === key)?.name ?? key;
      this.toasts.show(`バルーン「${name}」を読み込めませんでした: ${(e as Error).message} (内蔵バルーンを使います)`, { error: true });
      return BalloonSkin.builtin();
    });
  }

  openMenu(ghost: Ghost | undefined, x: number, y: number, above = false): void {
    const g = ghost?.alive ? ghost : undefined;
    void Promise.all([this.buildMenu(g), g ? menuSkin(g.shell.descript, (p) => g.shellFileUrl(p)) : undefined]).then(([items, skin]) =>
      this.menu.open(items, x, y, { above, skin, sidebar: BASEWARE_NAME }),
    );
  }

  changeGhost(from: Ghost, target: string, raiseEvent: boolean): void {
    const meta = this.resolveGhost(from, target);
    if (meta) void this.switchGhost(from, meta, raiseEvent);
  }

  callGhost(from: Ghost, target: string, raiseEvent = false): void {
    const meta = this.resolveGhost(from, target);
    if (!meta) return;
    void (async () => {
      if (raiseEvent) await from.raise('OnGhostCalling', [meta.sakuraName ?? meta.name, 'manual', meta.name, meta.key], { wait: true });
      await this.boot(meta, { kind: 'called', from: from.identity });
    })();
  }

  /** 名前のほか random・sequential (一覧で次のもの)・lastinstalled。起動中のものは選ばない */
  private resolveGhost(from: Ghost | undefined, target: string): PackageMeta | undefined {
    const ghosts = this.packages.filter((p) => p.kind === 'ghost');
    const t = target.trim().toLowerCase();
    if (t === 'random') {
      const c = ghosts.filter((p) => !this.isActive(p.key));
      return c[Math.floor(Math.random() * c.length)];
    }
    if (t === 'sequential') {
      const i = ghosts.findIndex((p) => p.key === from?.key);
      for (let k = 1; k <= ghosts.length; k++) {
        const p = ghosts[(i + k) % ghosts.length];
        if (!this.isActive(p.key)) return p;
      }
      return undefined;
    }
    if (t === 'lastinstalled') return this.findGhost(this.lastInstalledNames.ghost ?? '');
    return this.findGhost(target);
  }

  focus(ghost: Ghost): void {
    if (this.current === ghost) return;
    this.current = ghost;
    this.updateTray();
  }

  closed(ghost: Ghost): void {
    this.trayIcons.delete(ghost);
    if (this.ghosts.includes(ghost)) this.plugins.ghostExited(ghost);
    for (const [name, obj] of this.syncObjects) if (!obj.waiters.size && !obj.signaled) this.syncObjects.delete(name);
    const i = this.ghosts.indexOf(ghost);
    if (i >= 0) this.ghosts.splice(i, 1);
    if (this.current === ghost) this.current = this.ghosts[0];
    // 最後の1体が閉じられたときは、次回起動用にそのまま残す
    if (this.ghosts.length > 0) {
      settings.running = this.ghosts.map((g) => g.key);
      saveSettings();
    }
    this.updateEmptyState();
  }

  /** 入力ボックスは1つだけ。別のゴーストが開いている間は、それが終わってから開く */
  async input(ghost: Ghost, req: InputRequest): Promise<InputResult> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const ticket = { owner: ghost, kind: req.kind, id: req.id, cancelled: false, wake };
    this.queuedInputs.add(ticket);
    try {
      // 取り消されたら、前の入力ボックスが閉じるのを待たずにすぐ戻る
      while (this.openInput && this.openInput.owner !== ghost && !ticket.cancelled) {
        await Promise.race([this.openInput.done.catch(() => {}), woken]);
      }
    } finally {
      this.queuedInputs.delete(ticket);
    }
    // 待っている間に閉じるよう言われた、またはそのゴーストが終わっていたら開かない
    if (ticket.cancelled || ghost.leaving) return { cancelled: 'close' };
    const done = this.inputBox.open(req);
    const entry = { owner: ghost, kind: req.kind, id: req.id, done };
    this.openInput = entry;
    try {
      return await done;
    } finally {
      if (this.openInput === entry) this.openInput = undefined;
    }
  }

  /** そのゴーストの入力ボックスを閉じる。順番待ちのものも取り消す。filter で種類・ID を絞る */
  closeInput(ghost: Ghost, filter?: InputFilter): void {
    for (const t of this.queuedInputs) {
      if (!matchesInput(t, ghost, filter)) continue;
      t.cancelled = true;
      t.wake();
    }
    if (this.openInput && matchesInput(this.openInput, ghost, filter)) this.inputBox.close();
  }

  async sync(name: string, op: 'set' | 'reset' | 'wait', timeout = 0): Promise<void> {
    let obj = this.syncObjects.get(name);
    if (!obj) {
      obj = { signaled: false, waiters: new Set() };
      this.syncObjects.set(name, obj);
    }
    if (op === 'set') {
      obj.signaled = true;
      for (const w of [...obj.waiters]) w();
      return;
    }
    if (op === 'reset') {
      obj.signaled = false;
      return;
    }
    if (obj.signaled) return;
    const o = obj;
    await new Promise<void>((resolve) => {
      let timer: number | undefined;
      const done = () => {
        clearTimeout(timer);
        o.waiters.delete(done);
        resolve();
      };
      o.waiters.add(done);
      if (timeout > 0) timer = window.setTimeout(done, timeout);
    });
  }

  openTool(ghost: Ghost, tool: ToolName, args: string[]): void {
    openTool(this.toolHost(), ghost, tool, args);
  }

  private toolHost(): ToolHost {
    return {
      installed: () => this.packages,
      logs: (kind) => this.logs(kind),
      openOptions: () => this.openOptions(),
      openHelp: () => showHelp(README),
      openPackages: () => this.openPackages(),
      toast: (m) => this.toast(m),
    };
  }

  notify(ghost: Ghost, title: string, text: string, kind: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.toasts.show(text, { title: title || ghost.name, error: kind === 'error', duration: 15_000, onClick: () => resolve(true), onClose: () => resolve(false) });
    });
  }

  setTrayIcon(ghost: Ghost, url: string | undefined, text: string): void {
    if (url || text) this.trayIcons.set(ghost, { url, text });
    else this.trayIcons.delete(ghost);
    this.updateTray();
  }

  /** トレイのボタンに、選択中のゴーストのアイコンと文字を出す */
  private updateTray(): void {
    const icon = this.current ? this.trayIcons.get(this.current) : undefined;
    let img = this.tray.querySelector<HTMLImageElement>('.tray-ghost-icon');
    if (icon?.url) {
      if (!img) {
        img = el('img', { className: 'tray-ghost-icon', alt: '' });
        this.tray.prepend(img);
      }
      img.src = icon.url;
    } else img?.remove();
    this.tray.title = icon?.text || (this.current ? `${BASEWARE_NAME}/${this.current.name}` : BASEWARE_NAME);
  }

  /**
   * 消滅 (アンインストール)。query ならまず OnVanishSelecting を再生して確かめる (取り消したら OnVanishCancel)。
   * 消えたゴーストの代わりに別のゴーストを起動し、そのゴーストに OnVanished、ほかには OnOtherGhostVanished を送る
   */
  async vanish(ghost: Ghost, opts: { next?: string; query?: boolean }): Promise<void> {
    if (ghost.leaving) return;
    if (opts.query) {
      await ghost.vanishQuery('selecting');
      const ok = await confirmDialog({
        title: `「${ghost.name}」を消滅させますか？`,
        message: 'このゴーストをアンインストールします。セーブデータも一緒に消え、元に戻せません。',
        confirmLabel: '消滅',
        danger: true,
      });
      if (!ok) {
        await ghost.vanishQuery('cancel');
        return;
      }
    }
    const who = ghost.identity;
    const meta = ghost.meta;
    const shellName = ghost.shell.name;
    const script = await ghost.vanishOut();
    // 消滅のスクリプトの途中で取りやめられた (OnVanishButtonHold)
    if (script === undefined) return;
    try {
      await deletePackage(meta.key);
    } catch (e) {
      this.toasts.show(`「${meta.name}」を削除できませんでした: ${(e as Error).message}`, { error: true });
    }
    delete settings.ghosts[meta.key];
    settings.running = settings.running.filter((k) => k !== meta.key);
    saveSettings();
    await this.refreshPackages(true);
    const refs = [who.sakuraName, script, who.name, '', '', '', '', shellName];
    for (const g of this.ghosts) if (g.alive && !g.leaving) void g.raise('OnOtherGhostVanished', refs);
    const next = (opts.next ? this.findGhost(opts.next) : undefined) ?? this.resolveGhost(undefined, 'random');
    if (next && !this.isActive(next.key)) await this.boot(next, { kind: 'vanished', from: who, script });
    this.updateEmptyState();
  }

  /**
   * ネットワーク更新。ghost はゴースト全体、shell は今のシェル、balloon は今のバルーン。
   * 取り直したものがあれば読み直す
   */
  async update(ghost: Ghost, opts: UpdateRequest): Promise<void> {
    const summaries: UpdateSummary[] = [];
    let restart = false;
    for (const raw of opts.targets) {
      const t = raw.trim().toLowerCase();
      // --balloon=名前・--shell=名前 (\![updateother]) は、その名前のものを
      const named = /^--(balloon|shell)=(.*)$/i.exec(raw.trim());
      const kind = named ? named[1].toLowerCase() : t;
      let homeurl: string;
      let files: FileTree;
      let key = ghost.key;
      let prefix = '';
      let name = ghost.name;
      if (kind === 'ghost') {
        homeurl = ghost.descript.str('homeurl');
        files = ghost.files;
      } else if (kind === 'shell') {
        const dir = named ? ghost.shellDirs.find((d) => d === named[2].toLowerCase() || Shell.fromGhost(ghost.files, d).name === named[2]) : ghost.shell.dir;
        if (!dir) continue;
        const shell = Shell.fromGhost(ghost.files, dir);
        prefix = `shell/${dir}/`;
        name = shell.name;
        homeurl = shell.descript.str('homeurl') || ghost.descript.str('homeurl');
        files = ghost.files.sub(prefix.slice(0, -1));
      } else if (kind === 'balloon') {
        const meta = named ? this.packages.find((p) => p.kind === 'balloon' && p.name === named[2]) : this.packages.find((p) => p.key === ghost.skin.key);
        if (!meta) continue;
        key = meta.key;
        name = meta.name;
        files = await readPackageFiles(key);
        homeurl = Descript.read(files, 'descript.txt').str('homeurl');
      } else continue;
      if (!homeurl) {
        this.toasts.show(`「${name}」には更新の取得先 (homeurl) がありません`);
        summaries.push({ name, target: kind, result: { ok: false, changed: [], reason: '404' } });
        continue;
      }
      const res = await networkUpdate(
        homeurl,
        files,
        {
          raise: (id, refs) => ghost.raise(id, refs, { wait: true }),
          write: (path, data) => writePackageFile(key, prefix + path, data),
          remove: (paths, keep) => deletePackageFiles(key, paths.map((p) => prefix + p), keep.map((p) => prefix + p)),
        },
        { target: kind, reason: opts.reason, checkOnly: opts.checkOnly, testOnly: opts.testOnly, recovery: opts.recovery, other: kind !== 'ghost', ghostName: ghost.name, path: ghost.key },
      );
      summaries.push({ name, target: kind, result: res });
      if (!res.ok && res.reason === 'fetch') {
        this.toasts.show(`更新を取得できませんでした: ${homeurl} がブラウザからの取得を許していない (CORS) か、つながりません`, { error: true });
      }
      if (res.ok && res.changed.length && !opts.checkOnly && !opts.testOnly) {
        if (kind === 'balloon') {
          this.balloons.delete(key);
          if (ghost.skin.key === key) await ghost.changeBalloon(key, { force: true });
        } else restart = true;
      }
    }
    // すべての結果のまとめ (OnUpdateResultEx、返事が無ければ OnUpdateResult。調べるだけのときは …CheckResult…)
    if (summaries.length && ghost.alive && !ghost.leaving) {
      const base = opts.checkOnly ? 'OnUpdateCheckResult' : 'OnUpdateResult';
      const played = await ghost.raise(`${base}Ex`, updateResultRefs(summaries, true), { wait: true });
      if (!played) await ghost.raise(base, updateResultRefs(summaries, false), { wait: true });
    }
    if (restart) await this.restart(ghost, true);
  }

  async reload(ghost: Ghost, what: string): Promise<void> {
    const w = what.toLowerCase();
    if (w === 'balloon') {
      if (ghost.skin.key) this.balloons.delete(ghost.skin.key);
      await ghost.changeBalloon(ghost.skin.key, { force: true });
      return;
    }
    // シェルはゴーストを起こし直さずに読み直す (ゴーストが書き出したサーフェスの定義を読ませることがある)
    if (w === 'shell' || w === 'surface') {
      await ghost.reloadShell();
      return;
    }
    if (w === 'ghost' || w === 'shiori' || w.startsWith('descript')) await this.restart(ghost, true);
  }

  /** URL (http/https) かゴーストの中のファイルからインストールする */
  async installFrom(ghost: Ghost, url: string): Promise<void> {
    if (/^https?:/i.test(url)) {
      let data: Uint8Array;
      try {
        // 取得先はゴーストが決めるので、このページのクッキーは付けない
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        const reason = (e as Error).message === 'Failed to fetch' ? 'CORS かネットワークのため取得できません' : (e as Error).message;
        void ghost.raise('OnURLDropFailure', ['', reason, url, 0]);
        this.toasts.show(`「${url}」を取得できませんでした: ${reason}`, { error: true });
        return;
      }
      const last = new URL(url).pathname.split('/').pop() || 'download.nar';
      let name = last;
      try {
        name = decodeURIComponent(last);
      } catch {
        // 壊れた %xx はそのまま
      }
      await ghost.raise('OnURLDropped', [name, url, 0], { wait: true });
      await this.install(() => filesFromZip(data), name);
      return;
    }
    const path = url.replace(/^file:\/\/\/?/i, '');
    const data = ghost.files.get(path) ?? ghost.files.get(`ghost/master/${path}`);
    if (data) await this.install(() => filesFromZip(data), path.split('/').pop() ?? path);
    else this.toasts.show(`「${url}」が見つかりません`, { error: true });
  }

  lastInstalled(kind: 'ghost' | 'balloon' | 'shell'): string | undefined {
    return this.lastInstalledNames[kind];
  }

  log(ghost: Ghost, kind: 'request' | 'error' | 'script', text: string): void {
    this.addLog(kind, ghost.name, text);
  }

  /** プラグインのエラー (プラグインの名前でエラーログに) */
  private logPlugin(name: string, text: string): void {
    console.info(`[plugin ${name}]`, text);
    this.addLog('error', name, text);
  }

  private addLog(kind: 'request' | 'error' | 'script', name: string, text: string): void {
    const list = this.logStore.get(kind) ?? [];
    list.push({ type: kind === 'script' ? 'Ghost' : kind === 'error' ? 'Error' : 'Info', name, value: text, time: new Date() });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    this.logStore.set(kind, list);
  }

  logs(kind: string): LogEntry[] {
    return this.logStore.get(kind) ?? [];
  }

  toast(message: string): void {
    this.toasts.show(message);
  }

  /**
   * x-ukagaka-link:type=event&ghost=名前&info=文字 を開く。そのゴースト (名前か本体側の名前) に OnXUkagakaLinkOpen を送る
   * (SecurityLevel は external)。そのゴーストが起動していなければ何もしない
   */
  openUkagakaLink(link: string): boolean {
    const m = /^x-ukagaka-link:(.*)$/i.exec(link.trim());
    if (!m) return false;
    const params = new URLSearchParams(m[1]);
    if ((params.get('type') ?? 'event').toLowerCase() !== 'event') return false;
    const name = params.get('ghost') ?? '';
    const g = this.ghosts.find((x) => x.alive && !x.leaving && (x.name === name || x.sakuraName === name));
    if (!g) {
      this.toasts.show(`x-ukagaka-link の宛先「${name}」は起動していません`);
      return false;
    }
    void g.raise('OnXUkagakaLinkOpen', [params.get('info') ?? ''], { headers: { SecurityLevel: 'external' }, kinds: ['remote'] });
    return true;
  }

  /** SSTP を受ける相手 */
  private sstpHost(): SstpHost {
    return {
      ghosts: () => this.ghosts,
      current: () => this.current,
      installed: () => this.packages,
      refused: () => !settings.acceptRemoteSstp,
      cookies: this.sstpCookies,
      saveCookies: () => {
        try {
          localStorage.setItem(COOKIE_KEY, JSON.stringify(this.sstpCookies));
        } catch {
          // 保存できなくてもこのページの間は使える
        }
      },
      version: BASEWARE_VERSION,
      pluginNames: () => this.plugins.list().map((p) => p.name),
    };
  }

  /** SSTP の要求を処理する (local は同じページから) */
  sstp(request: string, local = true, origin = ''): Promise<string> {
    return handleSstp(request, this.sstpHost(), local, origin);
  }

  // ---------------------------------------------------------------- 起動

  /** 一覧を読み直す。失敗したら理由を返す (quiet でなければ通知もする) */
  private async refreshPackages(quiet = false): Promise<string | undefined> {
    try {
      this.packages = (await listPackages()).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      // 増えた・消えたプラグインを読み込み直す (待たない。読み込めたら起動中のゴーストの OnGhostBoot を送る)
      void this.plugins.sync(this.packages);
      return undefined;
    } catch (e) {
      const reason = (e as Error).message;
      if (!quiet) this.toasts.show(`保存領域を開けませんでした: ${reason}`, { error: true });
      return reason;
    }
  }

  private findGhost(target: string): PackageMeta | undefined {
    const ghosts = this.packages.filter((p) => p.kind === 'ghost');
    const t = target.trim();
    return ghosts.find((p) => p.key === t || p.name === t || p.dir === t.toLowerCase() || p.sakuraName === t);
  }

  /** 起動中・起動処理中・終了処理中 (同じパッケージをもう1体起動してはいけない間) */
  private isActive(key: string): boolean {
    return this.booting.has(key) || this.ghosts.some((g) => g.key === key);
  }

  private async installSample(): Promise<void> {
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await installFiles(filesFromZip(new Uint8Array(await res.arrayBuffer())), 'engawa');
      await this.refreshPackages();
    } catch (e) {
      console.warn('[engawa] sample ghost', e);
      this.toasts.show(`サンプルゴーストを用意できませんでした: ${(e as Error).message}`, { error: true });
    }
  }

  /** 前回起動していたゴースト (無ければ最初のゴースト) */
  private defaultGhosts(): PackageMeta[] {
    const metas = settings.running.map((k) => this.packages.find((p) => p.key === k)).filter((p): p is PackageMeta => !!p);
    if (metas.length) return metas;
    const first = this.packages.find((p) => p.kind === 'ghost');
    return first ? [first] : [];
  }

  private async bootDefault(): Promise<void> {
    for (const meta of this.defaultGhosts()) await this.boot(meta, { kind: 'boot' });
    this.updateEmptyState();
  }

  /** ゴーストキャッシュ (切り替えで離れたゴーストを、しばらく SHIORI ごと取っておく。新しい順) */
  private readonly cached: Ghost[] = [];
  private static readonly CACHE_SIZE = 2;

  private putInCache(ghost: Ghost): void {
    const i = this.ghosts.indexOf(ghost);
    if (i >= 0) this.ghosts.splice(i, 1);
    if (this.current === ghost) this.current = this.ghosts[0];
    this.cached.unshift(ghost);
    // キャッシュに入れたゴーストは、プラグインから見れば終わったもの
    this.plugins.ghostExited(ghost);
    // 多すぎる分は本当に終わらせる
    for (const old of this.cached.splice(GhostManager.CACHE_SIZE)) void old.destroy({ silent: true }).catch(() => undefined);
    settings.running = this.ghosts.map((g) => g.key);
    saveSettings();
  }

  /** キャッシュにあればそこから取り出す */
  private takeFromCache(key: string): Ghost | undefined {
    const i = this.cached.findIndex((g) => g.key === key && g.isSuspended);
    return i >= 0 ? this.cached.splice(i, 1)[0] : undefined;
  }

  /** キャッシュにあるゴーストを終わらせる (削除・更新のとき) */
  private dropFromCache(key: string): void {
    for (const g of this.cached.filter((x) => x.key === key)) {
      this.cached.splice(this.cached.indexOf(g), 1);
      void g.destroy({ silent: true }).catch(() => undefined);
    }
  }

  async boot(meta: PackageMeta, mode: BootMode): Promise<Ghost | undefined> {
    if (this.isActive(meta.key)) return undefined;
    const cached = mode.kind === 'changed' || mode.kind === 'called' || mode.kind === 'boot' ? this.takeFromCache(meta.key) : undefined;
    if (cached) {
      this.ghosts.push(cached);
      this.current = cached;
      addHistory('ghost', meta.key);
      settings.running = this.ghosts.map((g) => g.key);
      saveSettings();
      await cached.resume(mode);
      this.plugins.ghostBooted(cached);
      this.updateEmptyState();
      return cached;
    }
    this.dropFromCache(meta.key);
    this.booting.add(meta.key);
    this.updateEmptyState();
    let ghost: Ghost | undefined;
    try {
      const files = await readPackageFiles(meta.key);
      ghost = new Ghost(this, meta, files);
      this.ghosts.push(ghost);
      this.current = ghost;
      addHistory('ghost', meta.key);
      settings.running = this.ghosts.map((g) => g.key);
      saveSettings();
      await ghost.start(mode);
      if (ghost.alive) this.plugins.ghostBooted(ghost);
      return ghost;
    } catch (e) {
      console.error(e);
      // 切り替えの途中なら、利用者から見れば切り替えの失敗
      const what = mode.kind === 'changed' ? `「${meta.name}」に切り替えられませんでした` : `「${meta.name}」を起動できませんでした`;
      this.toasts.show(`${what}: ${(e as Error).message}`, { error: true });
      // 途中まで起動したゴーストを残さない
      // 起動しきっていないので、ほかのゴーストには何も知らせない
      await ghost?.destroy({ failedBoot: true }).catch((err) => console.warn('[engawa] cleanup after failed boot', err));
      return undefined;
    } finally {
      this.booting.delete(meta.key);
      this.updateEmptyState();
    }
  }

  private async switchGhost(from: Ghost, meta: PackageMeta, raiseEvent = true): Promise<void> {
    if (this.isActive(meta.key) || from.leaving) return;
    // 別れのあいさつの間に同じゴーストをもう一度選ばれても二重に起動しないよう、先に予約する
    this.booting.add(meta.key);
    try {
      const target = await this.identityOf(meta);
      const fromId = from.identity;
      const fromShell = from.shell.name;
      const cache = settings.ghostCache !== false && !this.options.embedded;
      const script = await from.leaveFor(target, raiseEvent, cache);
      this.booting.delete(meta.key);
      if (script === undefined) return;
      if (from.isSuspended) this.putInCache(from);
      const booted = await this.boot(meta, { kind: 'changed', from: fromId, script, fromShell });
      // 切り替え先が起動できなかったら、前のゴーストは終わっただけなので、ほかのゴーストにそう知らせる
      if (!booted) this.announceClosed(fromId, from.lastScript, fromShell);
    } catch (e) {
      this.toasts.show(`「${meta.name}」に切り替えられませんでした: ${(e as Error).message}`, { error: true });
    } finally {
      this.booting.delete(meta.key);
    }
  }

  /** いなくなったゴーストのことを、残っているゴーストに OnOtherGhostClosed で知らせる (R1 = 最後のスクリプト) */
  private announceClosed(who: GhostIdentity, lastScript: string, shellName: string): void {
    const refs = [who.sakuraName, lastScript, who.name, '', '', '', '', shellName];
    for (const g of this.ghosts) if (g.alive && !g.leaving) void g.raise('OnOtherGhostClosed', refs);
  }

  private async identityOf(meta: PackageMeta): Promise<GhostIdentity> {
    const files = await readPackageFiles(meta.key);
    const d = Descript.read(files, 'ghost/master/descript.txt');
    return { name: d.str('name', meta.name), sakuraName: d.str('sakura.name', meta.name), path: meta.key };
  }

  /** ゴーストが1体も動いていないときの案内。インストール済みかどうかで文と操作を変える */
  private updateEmptyState(): void {
    const show = !this.options.embedded && this.ghosts.length === 0 && this.booting.size === 0;
    this.emptyState.hidden = !show;
    if (!show) return;
    const next = this.defaultGhosts();
    this.emptyState.querySelector('.empty-title')!.textContent = next.length ? 'ゴーストが起動していません' : 'ゴーストがインストールされていません';
    // ボタンは作り直さない。表示と動作だけを今の状態に合わせる (前回複数起動していたら全部起動する)
    this.emptyButton.textContent =
      next.length > 1 ? `「${next[0].name}」ほか${next.length - 1}体を起動` : next.length ? `「${next[0].name}」を起動` : 'ファイルからインストール…';
    this.emptyAction = next.length ? () => void this.bootFromEmptyState() : () => this.pickFiles(false);
  }

  /** 空の状態のボタンから起動する。全部失敗して戻ってきたら、隠れている間に外れたフォーカスをボタンに戻す */
  private async bootFromEmptyState(): Promise<void> {
    await this.bootDefault();
    if (!this.emptyState.hidden && (document.activeElement === document.body || document.activeElement === null)) this.emptyButton.focus();
  }

  // ---------------------------------------------------------------- インストール

  /**
   * シェル・追加ファイルの宛先候補 (インストール済みのゴースト全部)。
   * 古いパッケージ情報に本体側の名前が無ければ descript.txt だけを読み、パッケージ情報に書き足しておく
   */
  private async installTargets(): Promise<InstallTarget[]> {
    const ghosts = this.packages.filter((p) => p.kind === 'ghost');
    const targets = await Promise.all(
      ghosts.map(async (p): Promise<InstallTarget | undefined> => {
        if (p.sakuraName && p.acceptNames) return { key: p.key, sakuraName: p.sakuraName, acceptNames: p.acceptNames };
        let read: { sakuraName: string; acceptNames: string[] };
        try {
          const data = await readPackageFile(p.key, 'ghost/master/descript.txt');
          const d = data ? Descript.parse(decodeText(data)) : new Descript();
          read = { sakuraName: d.str('sakura.name', p.sakuraName ?? p.name), acceptNames: acceptNamesOf(d) };
        } catch {
          // descript.txt が読めなくても、本体側の名前が分かっていれば宛先にする。分からなければ外すだけ
          return p.sakuraName ? { key: p.key, sakuraName: p.sakuraName, acceptNames: p.acceptNames ?? [] } : undefined;
        }
        // 保存されている情報に書き足す。読む間に新しい版が入って両方そろっていたら、そちらを使う。
        // 別のタブで消されていたら宛先にしない。書き込めなくても、読んだ値で宛先にはする
        const patched = await patchPackageMeta(p.key, read, (cur) => !!(cur.sakuraName && cur.acceptNames)).catch(() => null);
        if (patched === undefined) return undefined;
        return { key: p.key, sakuraName: patched?.sakuraName ?? read.sakuraName, acceptNames: patched?.acceptNames ?? read.acceptNames };
      }),
    );
    return targets.filter((t): t is InstallTarget => !!t);
  }

  /**
   * 展開からインストールまで。展開に失敗したときも OnInstallFailure を送る。
   * quiet なら、終わったことを通知しない (入れてすぐ起動するとき)。入れられなければ undefined
   */
  async install(source: () => Promise<FileTree> | FileTree, name: string, opts: { quiet?: boolean } = {}): Promise<InstallResult | undefined> {
    // イベントを受けるのは話せるゴーストだけ。ただし宛先 (accept が無いときの入れ先) は、あいさつ中でも選択中のゴースト
    const ghost = this.current?.alive && !this.current.leaving ? this.current : undefined;
    const focused = this.current?.alive ? this.current : undefined;
    await ghost?.raise('OnInstallBegin');
    let result: InstallResult;
    try {
      let tree: FileTree;
      try {
        tree = await source();
      } catch (e) {
        console.warn('[engawa] extraction', e);
        throw new InstallError('.nar / .zip として読めないファイルです', 'extraction');
      }
      result = await installFiles(tree, name, () => this.installTargets(), focused?.key);
    } catch (e) {
      // 保存領域のエラーなどは message が空のことがあるので、名前で補う
      const err = e as Error;
      const msg = err.message || err.name || String(e);
      if (e instanceof InstallError && e.refusal) {
        // 指名されたゴーストがいない (自分宛てでもない)。Reference0 = 宛先、1 = 種類、2 = 名前
        const { accept, type, name: itemName } = e.refusal;
        void ghost?.raise('OnInstallRefuse', [accept, type, itemName]);
      } else {
        void ghost?.raise('OnInstallFailure', [e instanceof InstallError ? e.reason : 'extraction', msg]);
      }
      this.toasts.show(`「${name}」をインストールできませんでした: ${msg}`, { error: true });
      return undefined;
    }
    await this.refreshPackages();
    for (const k of [result.key, ...result.balloons.map((b) => b.key)]) this.balloons.delete(k);
    for (const item of result.installed) {
      this.balloons.delete(item.key);
      this.lastInstalledNames[item.type] = item.name;
    }
    this.lastInstalledNames[result.type] = result.name;
    this.updateEmptyState();

    const completeRefs = [result.type, result.installName, result.balloons[0]?.name ?? ''];
    /** OnInstallCompleteEx (識別子・名前・場所をバイト値1区切りで。3つ以上でも全部)。返事が無ければ OnInstallComplete */
    const complete = async (g: Ghost | undefined) => {
      if (!g) return undefined;
      const items = result.installed;
      const ex = [items.map((i) => i.type).join('\x01'), items.map((i) => i.name).join('\x01'), items.map((i) => `/${i.key}/`).join('\x01')];
      return (await g.raise('OnInstallCompleteEx', ex)) ?? (await g.raise('OnInstallComplete', completeRefs));
    };
    this.installedBatch.push(...result.installed);
    this.plugins.installComplete(result.installed);
    // 終わりかけのゴーストには知らせない (再起動も勧めない)
    const target = this.ghosts.find((g) => g.key === result.key && g.alive && !g.leaving);
    let played: string | undefined;
    if (result.rerouted) {
      // 別のゴースト宛てだった。起動中なら、以降のインストールイベントはそちらへ
      played = await ghost?.raise('OnInstallRefuse', [result.accept ?? '', result.type, result.installName]);
      if (target && target !== ghost) {
        void ghost?.raise('OnInstallReroute', [result.accept ?? '', result.type, result.installName]);
        void complete(target);
      }
    } else {
      played = await complete(ghost);
    }

    const actions: { label: string; run(): void }[] = [];
    if (result.type === 'ghost') {
      const meta = this.packages.find((p) => p.key === result.key);
      if (meta && !this.isActive(meta.key)) {
        if (ghost) actions.push({ label: '切り替え', run: () => void this.switchGhost(ghost, meta) });
        actions.push({
          label: ghost ? '呼ぶ' : '起動',
          run: () => void this.boot(meta, ghost ? { kind: 'called', from: ghost.identity } : { kind: 'boot' }),
        });
      }
    } else if (result.type === 'balloon' && ghost) {
      actions.push({ label: '切り替え', run: () => void ghost.changeBalloon(result.key) });
    } else if ((result.type === 'shell' || result.type === 'supplement') && target) {
      // 起動中のゴーストはファイルの読み直しが必要
      actions.push({ label: '再起動', run: () => void this.restart(target) });
    }
    // 中に readme.txt があれば読めるようにする
    const readme = result.type === 'ghost' || result.type === 'balloon' ? await readPackageFile(result.key, 'readme.txt').catch(() => undefined) : undefined;
    if (readme) actions.push({ label: 'readme', run: () => showText(`${result.name} - readme`, decodeText(readme)) });
    const where = this.packages.find((p) => p.key === result.key)?.name;
    const message = result.rerouted
      ? `${packageKindLabel(result.type)}「${result.name}」を「${where ?? result.accept}」にインストールしました`
      : `${packageKindLabel(result.type)}「${result.name}」をインストールしました`;
    if (!opts.quiet && (!played || actions.length || result.rerouted)) this.toasts.show(message, { actions });
    return result;
  }

  /** インストール済みのパッケージ (キー) のゴーストを起動する。起動できたら true */
  async bootPackage(key: string): Promise<boolean> {
    const meta = this.packages.find((p) => p.key === key && p.kind === 'ghost');
    return !!meta && !!(await this.boot(meta, { kind: 'boot' }));
  }

  /** 保存領域を読み直す (よそから中身を消したあとなど) */
  async reloadPackages(): Promise<void> {
    await this.refreshPackages(true);
    this.balloons.clear();
  }

  /** reload なら、起動のあいさつをせずに読み直す (\![reload,ghost]・ネットワーク更新) */
  private async restart(ghost: Ghost, reload = false): Promise<void> {
    // 通知が古い (そのゴーストはもう閉じた・切り替わった・再起動した) ときは何もしない
    if (ghost.leaving) return;
    const meta = ghost.meta;
    const who = ghost.identity;
    const shellName = ghost.shell.name;
    try {
      // 再起動はほかのゴーストから見て終了ではないので知らせない
      await ghost.destroy({ silent: true, reload });
    } catch (e) {
      this.toasts.show(`「${meta.name}」を再起動できませんでした: ${(e as Error).message}`, { error: true });
      return;
    }
    await this.refreshPackages();
    const booted = await this.boot(this.packages.find((p) => p.key === meta.key) ?? meta, reload ? { kind: 'reload' } : { kind: 'boot' });
    // 起動し直せなかったら、結果として終了したことになるので知らせる
    if (!booted) this.announceClosed(who, ghost.lastScript, shellName);
  }

  private pickFiles(directory: boolean): void {
    const input = document.createElement('input');
    input.type = 'file';
    if (directory) input.webkitdirectory = true;
    else {
      input.accept = '.nar,.zip';
      input.multiple = true;
    }
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      if (directory) {
        const folder = files[0].webkitRelativePath.split('/')[0] || 'folder';
        await this.install(async () => (await filesFromFileList(files)).tree, folder);
      } else {
        // 「すべてのファイル」で選ばれた .nar / .zip 以外は、ドロップと同じく始めずに知らせる
        this.installedBatch = [];
        for (const f of files) {
          if (ARCHIVE.test(f.name)) await this.install(async () => filesFromZip(new Uint8Array(await f.arrayBuffer())), f.name);
          else this.rejectNonArchive(f.name);
        }
        this.completeBatch();
      }
    });
    input.click();
  }

  /** ドロップされたもののうち、フォルダと .nar / .zip だけをインストールする (画像などは無視) */
  /** その位置にいるゴーストとスコープ (デスクトップ座標) */
  private ghostAt(x: number, y: number): { ghost: Ghost; scope: number } | undefined {
    const box = this.desktop.getBoundingClientRect();
    const px = x - box.left;
    const py = y - box.top;
    for (const ghost of [...this.ghosts].reverse()) {
      if (!ghost.alive || ghost.leaving) continue;
      // \p[2] 以降のキャラクターも (『CLDSP2+』のプレイリストなど)。重なっていれば手前のもの
      for (const scope of ghost.visibleScopesTopFirst()) {
        const r = ghost.scopeRect(scope);
        if (r && px >= r.left && px < r.left + r.width && py >= r.top && py < r.top + r.height) return { ghost, scope };
      }
    }
    return undefined;
  }

  /**
   * ドロップ。キャラクターの上に落とした .nar / .zip とフォルダ以外のファイルはそのゴーストへ (OnFileDrop2 など)、
   * URL は OnURLQuery を経てインストール、文字は OnTextDrop
   */
  private async onDrop(dt: DataTransfer, x: number, y: number): Promise<void> {
    const at = this.ghostAt(x, y);
    const fileItems = [...dt.items].filter((i) => i.kind === 'file');
    // DataTransfer の中身はイベントの間しか読めないので、先に取り出しておく
    const entries = fileItems.map((i) => i.webkitGetAsEntry?.() ?? null);
    const dropped = fileItems.map((i) => i.getAsFile());
    const url = dt.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    const text = dt.getData('text/plain');
    const types = [...dt.types];
    // x-ukagaka-link: のリンクは、どこに落としても宛先のゴーストへ
    const link = [url, text].find((v) => v && /^x-ukagaka-link:/i.test(v.trim()));
    if (link) {
      this.openUkagakaLink(link.trim());
      return;
    }
    if (!fileItems.length) {
      if (!at) return;
      if (url && /^https?:/i.test(url)) await at.ghost.dropUrl(at.scope, url);
      else if (text) await at.ghost.dropText(at.scope, text);
      else if (types.length) await at.ghost.dropOther(at.scope, types);
      return;
    }
    if (at) {
      // インストールできるもの (install.txt やゴースト・シェル・バルーンの形) ではないフォルダは、そのゴーストへ
      const dirIndex = entries.findIndex((e) => e?.isDirectory);
      if (dirIndex >= 0 && fileItems.length === 1) {
        const entry = entries[dirIndex] as FileSystemDirectoryEntry;
        const tree = await filesFromDirectoryEntry(entry);
        const installable = tree.has('install.txt') || tree.list().some((p) => /(^|\/)(install\.txt|descript\.txt|surfaces\.txt|ghost\/master\/descript\.txt)$/i.test(p));
        if (!installable) {
          await at.ghost.dropDirectory(at.scope, entry.name, tree);
          return;
        }
        await this.install(() => tree, entry.name);
        return;
      }
      const plain = dropped.filter((f): f is File => !!f && !ARCHIVE.test(f.name));
      const dirs = entries.some((e) => e?.isDirectory);
      if (plain.length && plain.length === fileItems.length && !dirs) {
        const files = await Promise.all(plain.map(async (f) => ({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) })));
        if (await at.ghost.dropFiles(at.scope, files)) return;
      }
    }
    return this.installDropped(entries, dropped);
  }

  /** ドロップされたもののうち、フォルダと .nar / .zip だけをインストールする (画像などは無視) */
  private async installDropped(entries: (FileSystemEntry | null)[], files: (File | null)[]): Promise<void> {
    this.installedBatch = [];
    for (let i = 0; i < files.length; i++) {
      const entry = entries[i];
      const file = files[i];
      if (entry?.isDirectory) await this.install(() => filesFromDirectoryEntry(entry as FileSystemDirectoryEntry), entry.name);
      else if (file && ARCHIVE.test(file.name)) await this.install(async () => filesFromZip(new Uint8Array(await file.arrayBuffer())), file.name);
      // それ以外 (画像など) はインストールを始めない
      else if (file) this.rejectNonArchive(file.name);
    }
    this.completeBatch();
  }

  /** いくつかを続けてインストールし終えた (OnInstallCompleteAll) */
  private completeBatch(): void {
    const items = this.installedBatch;
    this.installedBatch = [];
    const g = this.current?.alive && !this.current.leaving ? this.current : undefined;
    if (!g || items.length < 2) return;
    void g.raise('OnInstallCompleteAll', [items.map((i) => i.type).join('\x01'), items.map((i) => i.name).join('\x01'), items.map((i) => `/${i.key}/`).join('\x01')]);
  }

  /** 続けてインストールしたもの (OnInstallCompleteAll 用) */
  private installedBatch: Installed[] = [];

  /** .nar / .zip でもフォルダでもないもの。インストールは始めず、ゴーストには知らせず、通知だけ出す */
  private rejectNonArchive(name: string): void {
    this.toasts.show(`「${name}」をインストールできませんでした: .nar / .zip ファイルかフォルダではありません`, { error: true });
  }

  // ---------------------------------------------------------------- メニュー

  private async buildMenu(target: Ghost | undefined): Promise<MenuItem[]> {
    const ghosts = this.packages.filter((p) => p.kind === 'ghost');
    const balloons = this.packages.filter((p) => p.kind === 'balloon');
    const items: MenuItem[] = [];
    const g = target?.alive ? target : undefined;

    if (g?.isMinimized) {
      // 最小化しているときは戻すことだけ (ほかの操作は戻してから)
      items.push({ label: `「${g.name}」を元に戻す`, key: 'R', action: () => g.restore('user') }, { separator: true });
    } else if (g) {
      const [recommend, portal, keroRecommend] = await Promise.all([g.sites('sakura.recommendsites'), g.sites('sakura.portalsites'), g.sites('kero.recommendsites')]);
      // メニューの名前・表示は SHIORI のリソースで変えられる (&X はショートカット)
      const caption = async (id: string, fallback: string): Promise<string> => (await g.resource(id))?.replace(/\(?&(.)\)?/, '') || fallback;
      const visible = async (id: string): Promise<boolean> => (await g.resource(id)) !== '0';
      const siteItems = (sites: typeof recommend, kind: 'recommend' | 'portal', scope: number): MenuItem[] =>
        sites.map((s, i) => (s.title === '-' ? { separator: true } : { label: s.title, action: () => void g.chooseSite(s, kind, scope, i) }));
      if (portal.length) items.push({ label: await caption('sakura.portalbuttoncaption', 'ポータル'), key: 'P', submenu: siteItems(portal, 'portal', 0) });
      if (recommend.length) items.push({ label: await caption('sakura.recommendbuttoncaption', 'おすすめ'), key: 'R', submenu: siteItems(recommend, 'recommend', 0) });
      if (keroRecommend.length) items.push({ label: await caption('kero.recommendbuttoncaption', `${g.keroName || '相方'}のおすすめ`), key: 'K', submenu: siteItems(keroRecommend, 'recommend', 1) });
      if (items.length) items.push({ separator: true });

      items.push({
        label: 'ゴースト切り替え',
        key: 'G',
        submenu: ghosts.map(
          (p): MenuItem => ({
            label: p.name,
            check: 'radio',
            checked: p.key === g.key,
            disabled: this.isActive(p.key),
            action: () => void this.switchGhost(g, p),
          }),
        ),
      });
      items.push({
        label: '他のゴーストを呼ぶ',
        key: 'C',
        submenu: ghosts.map(
          (p): MenuItem => ({
            label: p.name,
            disabled: this.isActive(p.key),
            action: () => void this.boot(p, { kind: 'called', from: g.identity }),
          }),
        ),
      });
      items.push({
        label: 'シェル',
        key: 'S',
        // \![set,property,currentghost.shelllist(…).menu,hidden] で隠したシェルは出さない (今のシェルは出す)
        submenu: g.shellDirs.filter((d, i) => d === g.shell.dir || g.property(`currentghost.shelllist.index(${i}).menu`) !== 'hidden').map(
          (d): MenuItem => ({
            label: Shell.fromGhost(g.files, d).name,
            check: 'radio',
            checked: d === g.shell.dir,
            action: () => void g.changeShell(d),
          }),
        ),
      });
      const dress: MenuItem[] = [];
      for (const scope of [0, 1, 2, 3]) {
        const groups = g.bindGroups(scope);
        if (!groups.length) continue;
        if (dress.length) dress.push({ separator: true });
        for (const b of groups) {
          dress.push({ label: `${b.category} / ${b.part}`, check: 'checkbox', checked: b.enabled, action: () => g.setDressup(scope, b.id) });
        }
      }
      items.push({ label: '着せ替え', key: 'D', submenu: dress });
      items.push({
        label: 'バルーン',
        key: 'B',
        submenu: [
          { label: '内蔵バルーン', check: 'radio', checked: g.skin.key === null, action: () => void g.changeBalloon(null) },
          ...balloons.map(
            (b): MenuItem => ({ label: b.name, check: 'radio', checked: g.skin.key === b.key, action: () => void g.changeBalloon(b.key) }),
          ),
        ],
      });
      items.push({ separator: true }, { label: '話しかける…', key: 'T', action: () => void g.communicate() }, { label: '教える…', key: 'E', action: () => void g.teach() });
      const history = (settings.history?.ghost ?? []).map((k) => this.packages.find((p) => p.key === k)).filter((p): p is PackageMeta => !!p && p.key !== g.key);
      if (history.length) {
        items.push({
          label: '最近使ったゴースト',
          key: 'Y',
          submenu: history.map((p): MenuItem => ({ label: p.name, disabled: this.isActive(p.key), action: () => void this.switchGhost(g, p) })),
        });
      }
      items.push({ separator: true });
      items.push({
        label: 'ユーティリティ',
        key: 'U',
        submenu: [
          { label: '位置のリセット', key: 'P', action: () => void g.requestResetPositions() },
          { label: 'バルーン位置のリセット', key: 'B', action: () => g.resetBalloonPositions() },
          { label: '最小化', key: 'M', disabled: g.passive, action: () => g.minimize('user') },
          { separator: true },
          { label: '使用率…', key: 'U', action: () => this.openTool(g, 'rateofusegraph', []) },
          { label: 'AI グラフ…', key: 'A', action: () => this.openTool(g, 'aigraph', []) },
          { separator: true },
          { label: '開発用パレット…', key: 'D', action: () => this.openTool(g, 'developer', []) },
          { label: 'サーフェステスト…', key: 'S', action: () => this.openTool(g, 'surfacetest', []) },
          { label: 'スクリプトログ…', key: 'L', action: () => this.openTool(g, 'backlogviewer', []) },
          { label: 'エラーログ…', key: 'E', action: () => this.openTool(g, 'errorlog', []) },
          { label: 'SHIORI リクエスト…', key: 'R', action: () => this.openTool(g, 'shiorirequest', []) },
          { label: 'スクリプトを送る…', key: 'I', action: () => this.openTool(g, 'sendbox', []) },
        ],
      });
      if (g.descript.str('homeurl')) {
        items.push({ label: await caption('updatebuttoncaption', 'ネットワーク更新'), key: 'N', action: () => void this.update(g, { targets: ['ghost'], reason: 'manual' }) });
      }
      if (hasReadme(g) && (await visible('readmebutton.visible'))) items.push({ label: await caption('readmebuttoncaption', 'Readme…'), key: 'M', action: () => this.openTool(g, 'readme', []) });
      if (!g.passive && (await visible('vanishbuttonvisible'))) {
        items.push({ label: await caption('vanishbuttoncaption', '消滅指示…'), key: 'V', action: () => void this.vanish(g, { query: true }) });
      }
    } else {
      items.push({
        label: 'ゴーストを起動',
        key: 'G',
        submenu: ghosts.map((p): MenuItem => ({ label: p.name, disabled: this.isActive(p.key), action: () => void this.boot(p, { kind: 'boot' }) })),
      });
      items.push({ separator: true });
    }

    // プラグイン (選ぶと OnMenuExec)。読み込めなかったものは選べない
    const plugins = this.plugins.list();
    if (plugins.length) {
      items.push({
        label: 'プラグイン',
        key: 'J',
        submenu: plugins.map((p): MenuItem => ({ label: p.failed ? `${p.name} (動かせません)` : p.name, disabled: !p.runnable, action: () => this.plugins.menuExec(p, g) })),
      });
      items.push({ separator: true });
    }
    items.push({
      label: 'インストール',
      key: 'I',
      submenu: [
        { label: 'ファイルからインストール…', key: 'F', action: () => this.pickFiles(false) },
        { label: 'フォルダからインストール…', key: 'D', action: () => this.pickFiles(true) },
        { separator: true },
        { label: 'インストール済み…', key: 'L', action: () => this.openPackages() },
      ],
    });
    items.push({ label: 'オプション…', key: 'O', action: () => this.openOptions() });
    items.push({ separator: true });
    items.push({ label: 'ヘルプ…', key: 'H', action: () => showHelp(README) });
    items.push({ label: 'ライセンス…', key: 'L', action: () => showLicenses(licenseText()) });
    items.push({ label: '情報…', key: 'A', action: () => this.openInfo(g) });
    if (g || this.ghosts.length > 1) items.push({ separator: true });
    if (g) items.push({ label: `「${g.name}」を閉じる`, key: 'X', disabled: g.passive, action: () => void this.closeGhost(g) });
    if (this.ghosts.length > 1) items.push({ label: 'すべて閉じる', key: 'Q', action: () => void this.closeAll() });
    return items;
  }

  private async closeGhost(ghost: Ghost, all = false): Promise<void> {
    try {
      await ghost.close('user', all);
    } catch (e) {
      this.toasts.show(`「${ghost.name}」を閉じられませんでした: ${(e as Error).message}`, { error: true });
    }
  }

  /** すべて閉じる。次回はいま起動しているゴーストを全部起動する */
  async closeAll(_reason = 'user'): Promise<void> {
    const keep = this.ghosts.map((g) => g.key);
    await Promise.all(this.ghosts.slice().map((g) => this.closeGhost(g, true)));
    settings.running = keep;
    saveSettings();
    this.updateEmptyState();
  }

  private openOptions(): void {
    showOptions(
      {
        talkWait: settings.talkWait,
        balloonTimeout: settings.balloonTimeout,
        choiceTimeout: settings.choiceTimeout,
        scale: settings.scale,
        balloonScale: settings.balloonScale,
        userName: settings.userName,
        speech: settings.speech,
        acceptRemoteSstp: settings.acceptRemoteSstp,
        voiceRecognition: settings.voiceRecognition ?? false,
      },
      {
        help: (id) => {
          const g = this.current?.alive ? this.current : undefined;
          if (g) void g.raise('OnConfigurationDialogHelp', [id]);
        },
        save: (m) => {
          const speechChanged = m.speech !== settings.speech;
          const voiceChanged = m.voiceRecognition !== (settings.voiceRecognition ?? false);
          const shell = m.scale !== settings.scale ? { before: settings.scale, after: m.scale } : undefined;
          const balloon = m.balloonScale !== settings.balloonScale ? { before: settings.balloonScale, after: m.balloonScale } : undefined;
          const user = m.userName !== settings.userName;
          Object.assign(settings, m);
          for (const g of this.ghosts) {
            g.scalingChanged(shell, balloon);
            if (user) void g.notify('OnNotifyUserInfo', [m.userName, m.userName, '', 'undef']);
          }
          if (speechChanged) this.environment.speechChanged();
          if (voiceChanged) this.environment.setVoiceRecognition(m.voiceRecognition);
          if (!saveSettingsNow()) {
            this.toasts.show('設定を保存できませんでした: このブラウザの保存領域が使えません (このページを開いている間だけ有効です)', { error: true });
          }
        },
      },
    );
  }

  private openPackages(): void {
    showPackages(
      this.packages.map((p) => ({ key: p.key, kind: p.kind, name: p.name, running: this.isActive(p.key) })),
      {
        uninstall: async (row) => {
          this.dropFromCache(row.key);
          await deletePackage(row.key);
          delete settings.ghosts[row.key];
          settings.running = settings.running.filter((k) => k !== row.key);
          // そのバルーンを選んでいたゴーストは、同梱バルーン (無ければ内蔵) に戻る
          for (const state of Object.values(settings.ghosts)) if (state.balloon === row.key) delete state.balloon;
          saveSettings();
          this.balloons.delete(row.key);
          // 削除はできている。一覧の読み直しに失敗したら、ダイアログの中で一緒に知らせる
          const failed = await this.refreshPackages(true);
          this.updateEmptyState();
          return failed ? `一覧を更新できませんでした: ${failed}` : undefined;
        },
      },
    );
  }

  private openInfo(ghost: Ghost | undefined): void {
    const sections = [];
    if (ghost) {
      const d = ghost.descript;
      const homeurl = d.str('homeurl');
      sections.push({
        heading: 'ゴースト',
        rows: [
          { label: '名前', value: ghost.name },
          { label: 'キャラクター', value: [ghost.sakuraName, ghost.keroName].filter(Boolean).join(' / ') },
          { label: '作者', value: d.str('craftmanw', d.str('craftman')) },
          { label: 'ホームページ', value: homeurl, href: /^https?:/.test(homeurl) ? homeurl : undefined },
          { label: 'SHIORI', value: d.str('shiori', 'shiori.dll') },
        ],
      });
      const sd = ghost.shell.descript;
      sections.push({
        heading: 'シェル',
        rows: [
          { label: '名前', value: ghost.shell.name },
          { label: '作者', value: sd.str('craftmanw', sd.str('craftman')) },
        ],
      });
      sections.push({ heading: 'バルーン', rows: [{ label: '名前', value: ghost.skin.name }] });
    }
    sections.push({
      heading: 'ベースウェア',
      rows: [
        { label: '名前', value: BASEWARE_NAME },
        { label: 'バージョン', value: BASEWARE_VERSION },
      ],
    });
    showInfo('情報', sections);
  }

  // ---------------------------------------------------------------- 全体のイベント

  /** タスクバーの時計 (時刻と日付の2行)。分が変わるたびに描き直す */
  private startClock(): void {
    const clock = this.overlay.querySelector<HTMLTimeElement>('.taskbar-clock');
    if (!clock) return;
    const pad = (n: number) => String(n).padStart(2, '0');
    const draw = () => {
      const now = new Date();
      const date = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
      clock.dateTime = `${date.replace(/\//g, '-')}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      clock.replaceChildren(el('span', {}, `${now.getHours()}:${pad(now.getMinutes())}`), el('span', {}, date));
      window.setTimeout(draw, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
    };
    draw();
  }

  private bindGlobalEvents(): void {
    const markInput = () => (this.lastInput = Date.now());
    window.addEventListener('pointerdown', markInput, { capture: true });
    window.addEventListener('keydown', markInput, { capture: true });
    window.addEventListener('resize', () => this.ghosts.forEach((g) => g.relayout()));

    // キー入力は、操作部品 (メニュー・ボタン・入力欄・ダイアログ・通知) に向けたものを除いて前面のゴーストへ。
    // バルーンの選択肢・アンカーはゴーストの一部なので、それを選ぶ Enter / Space だけを除く
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.defaultPrevented || this.menu.isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      const balloonLink = t.closest('.balloon a');
      if (balloonLink && (e.key === 'Enter' || e.key === ' ')) return;
      if (!balloonLink && t.closest('input, textarea, select, button, a, dialog, [contenteditable], .menu-layer, .toasts')) return;
      this.current?.keyPress(keyName(e), e.keyCode);
    });

    this.tray.addEventListener('click', () => {
      if (this.menu.isOpen) {
        this.menu.close();
        return;
      }
      this.menuFromTray = true;
      // 通知領域のメニューと同じく、タスクバーの上にトレイの右端で揃えて出す
      const r = this.tray.getBoundingClientRect();
      const bar = this.tray.closest('.taskbar')?.getBoundingClientRect() ?? r;
      this.openMenu(this.current, r.right, bar.top, true);
    });

    // 埋め込みでは、よそのページへのドロップを横取りしない
    if (!this.options.embedded) this.bindDrop();

    // 開発・連携用の API。sstp は SSTP の要求文をそのまま受けて応答文を返す
    (window as unknown as { engawa: unknown }).engawa = {
      send: (script: string) => this.current?.playScript(script),
      raise: (id: string, ...refs: string[]) => this.current?.raise(id, refs),
      ghosts: () => this.ghosts.map((g) => g.name),
      sstp: (request: string) => this.sstp(request, true),
      // 互換性の試験 (tools/compat-check.mjs) が使う: 起動中のゴーストの様子と、ログ
      status: () => this.ghosts.map((g) => ({ name: g.name, key: g.key, shiori: g.shioriName, shell: g.shell?.name, status: g.status(), surfaces: [g.surfaceOf(0), g.surfaceOf(1)] })),
      logs: (kind: string) => this.logs(kind).map((l) => `${l.name}: ${l.value}`),
      plugins: () => this.plugins.list().map((p) => ({ name: p.name, id: p.id, version: p.version, runnable: p.runnable, failed: p.failed })),
      close: () => this.current?.close(),
    };
    // x-ukagaka-link: のリンク (ページのリンクを押したとき・アドレスの ?x-ukagaka-link=… / #x-ukagaka-link:…)
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target instanceof Element ? e.target.closest('a[href^="x-ukagaka-link:" i]') : null;
        if (!a) return;
        e.preventDefault();
        this.openUkagakaLink(a.getAttribute('href') ?? '');
      },
      true,
    );
    // よそのページ・フレームからの SSTP: postMessage({ type: 'sstp', request, id }) に { type: 'sstp-response', id, response } で答える
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: unknown; request?: unknown; id?: unknown } | null;
      if (!d || d.type !== 'sstp' || typeof d.request !== 'string') return;
      const local = e.origin === location.origin && e.source === window;
      void this.sstp(d.request, local, e.origin).then((response) => {
        const target = e.source as Window | null;
        target?.postMessage({ type: 'sstp-response', id: d.id, response }, { targetOrigin: e.origin && e.origin !== 'null' ? e.origin : '*' });
      });
    });
  }

  private bindDrop(): void {
    const dropHint = this.overlay.querySelector<HTMLElement>('.drop-hint')!;
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      dropHint.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) dropHint.hidden = true;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      dropHint.hidden = true;
      if (e.dataTransfer) void this.onDrop(e.dataTransfer, e.clientX, e.clientY);
    });
  }
}

/** KeyboardEvent を OnKeyPress の Reference0 (SSP のキー名) にする */
function keyName(e: KeyboardEvent): string {
  const special: Record<string, string> = {
    Enter: 'return',
    Escape: 'escape',
    ' ': 'space',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Backspace: 'back',
    Delete: 'delete',
    Tab: 'tab',
    Home: 'home',
    End: 'end',
    PageUp: 'prior',
    PageDown: 'next',
  };
  return special[e.key] ?? e.key.toLowerCase();
}
