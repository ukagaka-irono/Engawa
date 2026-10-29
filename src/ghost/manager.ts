import { BalloonSkin } from '../balloon/skin';
import { Descript } from '../package/descript';
import { acceptNamesOf, InstallError, installFiles, type InstallResult, type InstallTarget } from '../package/installer';
import { CharacterLayer } from '../shell/character-layer';
import { Shell } from '../shell/shell';
import { InputBox, packageKindLabel, showHelp, showInfo, showOptions, showPackages, Toasts } from '../ui/dialogs';
import { el } from '../ui/dom';
import { menuSkin } from '../ui/menu-skin';
import { ContextMenu, type MenuItem } from '../ui/menu';
import { filesFromDirectoryEntry, filesFromFileList, filesFromZip } from '../vfs/archive';
import type { FileTree } from '../vfs/files';
import { decodeText } from '../util/text';
import {
  deletePackage,
  isPersistent,
  listPackages,
  patchPackageMeta,
  readPackageFile,
  readPackageFiles,
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
} from './ghost';
import { saveSettings, saveSettingsNow, settings } from './settings';

// ビルドでは data: URL として index.html に埋め込まれる (file:// で開いても読めるように)
import SAMPLE_URL from '../assets/engawa.nar?url';
import README from '../../README.md?raw';
const ARCHIVE = /\.(nar|zip)$/i;

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
  if (filter.kind === 'communicatebox') return slot.kind === 'communicatebox';
  return slot.kind === 'inputbox' && (!filter.id || filter.id === '__SYSTEM_ALL_INPUT__' || slot.id === filter.id);
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

  constructor(
    readonly desktop: HTMLElement,
    private readonly overlay: HTMLElement,
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
  }

  async init(): Promise<void> {
    this.bindGlobalEvents();
    this.startClock();
    const loop = (now: number) => {
      for (const g of this.ghosts) g.tick(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    await this.refreshPackages();
    if (!(await isPersistent())) {
      this.toasts.show('このブラウザでは保存領域が使えないため、インストールしたものや設定はページを閉じると消えます', {
        duration: 12_000,
      });
    }
    if (!this.packages.some((p) => p.kind === 'ghost')) await this.installSample();
    await this.bootDefault();
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
    const meta = this.findGhost(target);
    if (meta) void this.switchGhost(from, meta, raiseEvent);
  }

  callGhost(from: Ghost, target: string): void {
    const meta = this.findGhost(target);
    if (meta) void this.boot(meta, { kind: 'called', from: from.identity });
  }

  focus(ghost: Ghost): void {
    this.current = ghost;
  }

  closed(ghost: Ghost): void {
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

  // ---------------------------------------------------------------- 起動

  /** 一覧を読み直す。失敗したら理由を返す (quiet でなければ通知もする) */
  private async refreshPackages(quiet = false): Promise<string | undefined> {
    try {
      this.packages = (await listPackages()).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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

  async boot(meta: PackageMeta, mode: BootMode): Promise<Ghost | undefined> {
    if (this.isActive(meta.key)) return undefined;
    this.booting.add(meta.key);
    this.updateEmptyState();
    let ghost: Ghost | undefined;
    try {
      const files = await readPackageFiles(meta.key);
      ghost = new Ghost(this, meta, files);
      this.ghosts.push(ghost);
      this.current = ghost;
      settings.running = this.ghosts.map((g) => g.key);
      saveSettings();
      await ghost.start(mode);
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
      const script = await from.leaveFor(target, raiseEvent);
      this.booting.delete(meta.key);
      if (script === undefined) return;
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
    const show = this.ghosts.length === 0 && this.booting.size === 0;
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

  /** 展開からインストールまで。展開に失敗したときも OnInstallFailure を送る */
  async install(source: () => Promise<FileTree> | FileTree, name: string): Promise<void> {
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
      return;
    }
    await this.refreshPackages();
    for (const k of [result.key, ...result.balloons.map((b) => b.key)]) this.balloons.delete(k);
    this.updateEmptyState();

    const completeRefs = [result.type, result.installName, result.balloons[0]?.name ?? ''];
    // 終わりかけのゴーストには知らせない (再起動も勧めない)
    const target = this.ghosts.find((g) => g.key === result.key && g.alive && !g.leaving);
    let played: string | undefined;
    if (result.rerouted) {
      // 別のゴースト宛てだった。起動中なら、以降のインストールイベントはそちらへ
      played = await ghost?.raise('OnInstallRefuse', [result.accept ?? '', result.type, result.installName]);
      if (target && target !== ghost) {
        void ghost?.raise('OnInstallReroute', [result.accept ?? '', result.type, result.installName]);
        void target.raise('OnInstallComplete', completeRefs);
      }
    } else {
      played = await ghost?.raise('OnInstallComplete', completeRefs);
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
    const where = this.packages.find((p) => p.key === result.key)?.name;
    const message = result.rerouted
      ? `${packageKindLabel(result.type)}「${result.name}」を「${where ?? result.accept}」にインストールしました`
      : `${packageKindLabel(result.type)}「${result.name}」をインストールしました`;
    if (!played || actions.length || result.rerouted) this.toasts.show(message, { actions });
  }

  private async restart(ghost: Ghost): Promise<void> {
    // 通知が古い (そのゴーストはもう閉じた・切り替わった・再起動した) ときは何もしない
    if (ghost.leaving) return;
    const meta = ghost.meta;
    const who = ghost.identity;
    const shellName = ghost.shell.name;
    try {
      // 再起動はほかのゴーストから見て終了ではないので知らせない
      await ghost.destroy({ silent: true });
    } catch (e) {
      this.toasts.show(`「${meta.name}」を再起動できませんでした: ${(e as Error).message}`, { error: true });
      return;
    }
    await this.refreshPackages();
    const booted = await this.boot(this.packages.find((p) => p.key === meta.key) ?? meta, { kind: 'boot' });
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
        for (const f of files) {
          if (ARCHIVE.test(f.name)) await this.install(async () => filesFromZip(new Uint8Array(await f.arrayBuffer())), f.name);
          else this.rejectNonArchive(f.name);
        }
      }
    });
    input.click();
  }

  /** ドロップされたもののうち、フォルダと .nar / .zip だけをインストールする (画像などは無視) */
  private async onDrop(dt: DataTransfer): Promise<void> {
    const items = [...dt.items].filter((i) => i.kind === 'file');
    // DataTransfer の中身はイベントの間しか読めないので、先に取り出しておく
    const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
    const files = items.map((i) => i.getAsFile());
    for (let i = 0; i < items.length; i++) {
      const entry = entries[i];
      const file = files[i];
      if (entry?.isDirectory) await this.install(() => filesFromDirectoryEntry(entry as FileSystemDirectoryEntry), entry.name);
      else if (file && ARCHIVE.test(file.name)) await this.install(async () => filesFromZip(new Uint8Array(await file.arrayBuffer())), file.name);
      // それ以外 (画像など) はインストールを始めない
      else if (file) this.rejectNonArchive(file.name);
    }
  }

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

    if (g) {
      const [recommend, portal] = await Promise.all([g.sites('sakura.recommendsites'), g.sites('sakura.portalsites')]);
      const siteItems = (sites: typeof recommend): MenuItem[] =>
        sites.map((s) => (s.title === '-' ? { separator: true } : { label: s.title, action: () => g.openUrl(s.url) }));
      if (portal.length) items.push({ label: 'ポータル', key: 'P', submenu: siteItems(portal) });
      if (recommend.length) items.push({ label: 'おすすめ', key: 'R', submenu: siteItems(recommend) });
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
        submenu: g.shellDirs.map(
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
      items.push({ separator: true }, { label: '話しかける…', key: 'T', action: () => void g.communicate() });
    } else {
      items.push({
        label: 'ゴーストを起動',
        key: 'G',
        submenu: ghosts.map((p): MenuItem => ({ label: p.name, disabled: this.isActive(p.key), action: () => void this.boot(p, { kind: 'boot' }) })),
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
    items.push({ label: '情報…', key: 'A', action: () => this.openInfo(g) });
    if (g || this.ghosts.length > 1) items.push({ separator: true });
    if (g) items.push({ label: `「${g.name}」を閉じる`, key: 'X', action: () => void this.closeGhost(g) });
    if (this.ghosts.length > 1) items.push({ label: 'すべて閉じる', key: 'Q', action: () => void this.closeAll() });
    return items;
  }

  private async closeGhost(ghost: Ghost): Promise<void> {
    try {
      await ghost.close();
    } catch (e) {
      this.toasts.show(`「${ghost.name}」を閉じられませんでした: ${(e as Error).message}`, { error: true });
    }
  }

  /** すべて閉じる。次回はいま起動しているゴーストを全部起動する */
  private async closeAll(): Promise<void> {
    const keep = this.ghosts.map((g) => g.key);
    await Promise.all(this.ghosts.slice().map((g) => this.closeGhost(g)));
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
        userName: settings.userName,
      },
      {
        save: (m) => {
          Object.assign(settings, m);
          for (const g of this.ghosts) g.relayout();
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
      clock.dateTime = `${date.replaceAll('/', '-')}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
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
      if (e.dataTransfer) void this.onDrop(e.dataTransfer);
    });

    // 開発・連携用の簡易 API (SSTP の代わり)
    (window as unknown as { engawa: unknown }).engawa = {
      send: (script: string) => this.current?.playScript(script),
      raise: (id: string, ...refs: string[]) => this.current?.raise(id, refs),
      ghosts: () => this.ghosts.map((g) => g.name),
    };
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
