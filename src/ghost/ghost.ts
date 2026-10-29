import { BalloonView } from '../balloon/balloon-view';
import type { BalloonSkin } from '../balloon/skin';
import { Descript } from '../package/descript';
import type { SaoriEffect } from '../saori/context';
import { ScriptPlayer, type InlineImageOptions, type PlayerHost, type PlayResult } from '../sakura/player';
import { buildRequest, parseResponse, type Reference, type ShioriMethod } from '../shiori/protocol';
import { createShiori, type Shiori } from '../shiori/shiori';
import { UnsupportedShiori } from '../shiori/unsupported-shiori';
import type { CharacterLayer } from '../shell/character-layer';
import { CharacterView, type CharacterMouseEvent } from '../shell/character-view';
import { SurfaceRenderer } from '../shell/renderer';
import { Shell } from '../shell/shell';
import { copyText } from '../util/clipboard';
import { loadTransparentImage } from '../util/image';
import { joinPath, normalizePath, type FileTree } from '../vfs/files';
import { writePackageFile, type PackageMeta } from '../vfs/storage';
import { ghostState, saveSettings, settings, type GhostState } from './settings';

export const BASEWARE_NAME = 'Engawa';
export const BASEWARE_VERSION = '0.1.0';

export type BootMode =
  | { kind: 'boot' }
  /** 切り替え。script は前のゴーストの切り替え時のスクリプト、fromShell はそのシェル名 */
  | { kind: 'changed'; from: GhostIdentity; script: string; fromShell: string }
  | { kind: 'called'; from: GhostIdentity };

export interface GhostIdentity {
  name: string;
  sakuraName: string;
  path: string;
}

export type InputKind = 'inputbox' | 'communicatebox';

export interface InputRequest {
  title: string;
  /** \![close,inputbox,ID] / \![close,communicatebox] で閉じる対象を選ぶため */
  kind: InputKind;
  id?: string;
  defaultText?: string;
  password?: boolean;
  timeout?: number;
}

/** \![close,…] で閉じる入力ボックス。id が無いか __SYSTEM_ALL_INPUT__ なら、その種類のすべて */
export interface InputFilter {
  kind: InputKind;
  id?: string;
}

/** 入力ボックスの結果。閉じられたか時間切れかを区別する (OnUserInputCancel の Reference1) */
export type InputResult = { value: string } | { cancelled: 'close' | 'timeout' };

export interface Site {
  title: string;
  url: string;
}

/** ゴーストから見たベースウェア (GhostManager が実装する) */
export interface GhostEnv {
  readonly desktop: HTMLElement;
  readonly characters: CharacterLayer;
  lastInputAt(): number;
  others(self: Ghost): Ghost[];
  installed(): PackageMeta[];
  loadBalloon(key: string | null): Promise<BalloonSkin>;
  openMenu(ghost: Ghost, x: number, y: number): void;
  /** raiseEvent: OnGhostChanging を送るか (メニューからは常に、スクリプトからは --option=raise-event のときだけ) */
  changeGhost(from: Ghost, target: string, raiseEvent: boolean): void;
  callGhost(from: Ghost, target: string): void;
  focus(ghost: Ghost): void;
  closed(ghost: Ghost): void;
  input(ghost: Ghost, req: InputRequest): Promise<InputResult>;
  /** そのゴーストの入力ボックス (順番待ちを含む) を閉じる。filter が無ければすべて */
  closeInput(ghost: Ghost, filter?: InputFilter): void;
}

interface Scope {
  renderer: SurfaceRenderer;
  view: CharacterView;
  balloon: BalloonView;
}

interface RaiseOptions {
  /** 喋っている最中なら結果を再生しない (時間イベント・マウス移動など) */
  ifIdle?: boolean;
  method?: ShioriMethod;
  /** 返ってきたスクリプトの再生が終わるまで待つ */
  wait?: boolean;
}

const CLOSE_GRACE_MS = 800;
/** バルーンが閉じてから OnSurfaceRestore までの時間 (SSP と同じ) */
const RESTORE_DELAY_MS = 15_000;

/** 起動中のゴースト1体。SHIORI・シェル・バルーン・スクリプト再生をまとめる。 */
export class Ghost implements PlayerHost {
  readonly descript: Descript;
  readonly name: string;
  readonly sakuraName: string;
  readonly keroName: string;
  shell!: Shell;
  skin!: BalloonSkin;
  lastScript = '';

  private shiori?: Shiori;
  private readonly player = new ScriptPlayer(this);
  private readonly scopes = new Map<number, Scope>();
  private readonly state: GhostState;
  private dressup = new Map<number, Set<number>>();
  /** \![timerraise] / \![timernotify] (イベント名ごとに1つ) */
  private readonly namedTimers = new Map<string, number>();
  private balloonTimer?: number;
  private restoreTimer?: number;
  private secondTimer?: number;
  private secondBusy = false;
  private elapsedSec = 0;
  private lastMinute = new Date().getMinutes();
  /** \![set,balloontimeout] などでスクリプトが一時的に変えた値 (そのスクリプトの間だけ有効) */
  private balloonTimeout?: number;
  private choiceTimeout?: number;
  /** スクリプトからの変更 (シェル・バルーン・着せ替え) のイベントは、そのスクリプトが終わってから送る */
  private afterScript: (() => void)[] = [];
  private readonly bootedAt = Date.now();
  /** SHIORI の準備ができ、起動イベントを送った後 */
  private ready = false;
  private closing = false;
  private destroyed = false;
  /** 開いている・順番待ちの入力ボックスの数 (1つ閉じても、ほかが残っていれば入力待ち) */
  private inputs = 0;
  private readonly blobUrls = new Map<string, string>();
  private sounds: HTMLAudioElement[] = [];
  private userName?: string;
  private previous?: GhostIdentity;
  /**
   * 切り替えで起動したときの OnOtherGhostChanged。あいさつの後に送るが、その前に終わったら destroy で送る
   * (切り替わったこと自体は、ほかのゴーストに必ず知らせる)
   */
  private changeNotice?: string[];

  constructor(
    private readonly env: GhostEnv,
    readonly meta: PackageMeta,
    readonly files: FileTree,
  ) {
    this.descript = Descript.read(files, 'ghost/master/descript.txt');
    this.name = this.descript.str('name', meta.dir);
    this.sakuraName = this.descript.str('sakura.name', this.name);
    this.keroName = this.descript.str('kero.name');
    this.state = ghostState(meta.key);
  }

  get key(): string {
    return this.meta.key;
  }

  get identity(): GhostIdentity {
    return { name: this.name, sakuraName: this.sakuraName, path: this.meta.key };
  }

  get shellDirs(): string[] {
    return this.files.dirs('shell').filter((d) => this.files.has(`shell/${d}/descript.txt`) || this.files.has(`shell/${d}/surfaces.txt`));
  }

  /** 喋っている・選択肢を出している・入力待ち */
  get busy(): boolean {
    return this.player.playing || this.inputs > 0 || [...this.scopes.values()].some((s) => s.balloon.shown && s.balloon.hasChoices);
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  /** 終了処理に入っている (OnClose・切り替え中) */
  get leaving(): boolean {
    return this.closing || this.destroyed;
  }

  private defaultSurface(scope: number): number {
    const fallback = scope === 0 ? 0 : scope === 1 ? 10 : -1;
    return this.descript.num(`${Shell.scopePrefix(scope)}.seriko.defaultsurface`, fallback);
  }

  // ---------------------------------------------------------------- 起動と終了

  /**
   * 起動する。SHIORI を読み込んで起動イベントを送るまで待ち、起動時のスクリプトの再生は待たない。
   * 途中で閉じられたら (destroy されたら) そこで止める。
   */
  async start(mode: BootMode): Promise<void> {
    const dirs = this.shellDirs;
    const shellDir = this.state.shell && dirs.includes(this.state.shell) ? this.state.shell : dirs.includes('master') ? 'master' : dirs[0];
    this.shell = Shell.fromGhost(this.files, shellDir ?? 'master');
    if (mode.kind === 'changed') {
      // R0/R1: 前後の本体側の名前、R2/R3: 切り替え時のスクリプト、R4/R5: ゴースト名、R14/R15: シェル名
      const refs: string[] = [mode.from.sakuraName, this.sakuraName, mode.script, '', mode.from.name, this.name];
      refs[14] = mode.fromShell;
      refs[15] = this.shell.name;
      this.changeNotice = refs;
    }
    // 保存してあるバルーンが削除されていたら、同梱のバルーン → 内蔵バルーンの順に使う
    const installed = (key?: string) => (key && this.env.installed().some((p) => p.key === key) ? key : undefined);
    this.skin = await this.env.loadBalloon(installed(this.state.balloon) ?? installed(this.meta.defaultBalloon) ?? null);
    if (this.destroyed) return;
    this.loadDressup();
    // kero は sakura の左に並べるので、sakura の大きさが決まってから置く
    await this.setSurface(0, String(this.defaultSurface(0)));
    if (this.destroyed) return;
    await this.setSurface(1, String(this.defaultSurface(1)));
    if (this.destroyed) return;

    let shiori = createShiori(this.files, this.descript, {
      onWrite: (path, data) => this.saveFile(path, data),
      onLog: (m) => console.info(`[${this.name}]`, m),
      onSaori: (effect) => this.onSaori(effect),
    });
    try {
      await shiori.load();
    } catch (e) {
      console.error(`[${this.name}] SHIORI load failed`, e);
      shiori = new UnsupportedShiori(`${shiori.name} (読み込み失敗: ${(e as Error).message})`);
    }
    // 読み込みの間に閉じられた。起動イベントは送らず、ここで読み込んだ SHIORI を片付ける
    if (this.leaving) {
      await shiori.unload();
      return;
    }
    this.shiori = shiori;

    await this.request('GET', 'version');
    await this.notify('basewareversion', [BASEWARE_VERSION, BASEWARE_NAME]);
    await this.notify('ownerghostname', [this.sakuraName]);
    const others = this.env.others(this);
    await this.notify('otherghostname', others.map((g) => `${g.sakuraName}\x01${g.surfaceOf(0)}\x01${g.surfaceOf(1)}`));
    const ghosts = this.env.installed().filter((p) => p.kind === 'ghost');
    await this.notify('installedghostname', ghosts.map((p) => p.name));
    await this.notify('installedballoonname', ['内蔵バルーン', ...this.env.installed().filter((p) => p.kind === 'balloon').map((p) => p.name)]);
    await this.notify('installedshellname', this.shellDirs.map((d) => Shell.fromGhost(this.files, d).name));
    this.userName = await this.request('GET', 'username');
    if (this.leaving) return;

    this.secondTimer = window.setInterval(() => void this.onSecond(), 1000);
    const firstBoot = !this.state.bootCount;
    this.state.bootCount = (this.state.bootCount ?? 0) + 1;
    saveSettings();
    this.ready = true;
    void this.bootTalk(mode, firstBoot);
  }

  /**
   * 起動イベント。再生し終わってから、他のゴーストに知らせる。
   * 呼び出されたときは呼び出し元に OnGhostCallComplete、ほかに OnOtherGhostBooted。
   * 切り替わったときはほかのゴーストに OnOtherGhostChanged。普通の起動 (前回の続きなど) では知らせない。
   */
  private async bootTalk(mode: BootMode, firstBoot: boolean): Promise<void> {
    let value: string | undefined;
    if (mode.kind === 'changed') {
      this.previous = mode.from;
      value = await this.request('GET', 'OnGhostChanged', [mode.from.sakuraName, mode.script, mode.from.name, mode.from.path]);
    } else if (mode.kind === 'called') {
      value = await this.request('GET', 'OnGhostCalled', [mode.from.sakuraName, '', mode.from.name, mode.from.path]);
    } else if (firstBoot) {
      value = await this.request('GET', 'OnFirstBoot', [0]);
    }
    if (!value) value = await this.request('GET', 'OnBoot', [this.shell.name]);
    if (this.changeNotice) this.changeNotice[3] = value ?? '';
    if (value) await this.playScript(value);
    // 切り替わったこと自体は、あいさつの途中で閉じられても知らせる (閉じられたら destroy で送り済み)
    this.flushChangeNotice();
    if (this.leaving || mode.kind !== 'called') return;
    const refs = [this.sakuraName, value ?? '', this.name, '', '', '', '', this.shell.name];
    for (const g of this.env.others(this)) void g.raise(g.key === mode.from.path ? 'OnGhostCallComplete' : 'OnOtherGhostBooted', refs);
  }

  /** 送っていない OnOtherGhostChanged があれば、ほかのゴーストへ送る */
  private flushChangeNotice(): void {
    const refs = this.changeNotice;
    if (!refs) return;
    this.changeNotice = undefined;
    for (const g of this.env.others(this)) void g.raise('OnOtherGhostChanged', refs);
  }

  /** メニューの「閉じる」など。OnClose のスクリプトを再生してから終了する。 */
  async close(reason = 'user'): Promise<void> {
    if (this.closing || this.destroyed) return;
    this.closing = true;
    this.player.abort();
    const value = await this.request('GET', 'OnClose', [reason]);
    if (value) await this.playScript(value);
    await this.finishClose();
  }

  /**
   * 別のゴーストに切り替わる。OnGhostChanging (返事が無ければ OnClose) を再生して終了し、
   * 再生したスクリプトを返す (切り替え先の OnGhostChanged の Reference1)。既に終了処理中なら undefined。
   */
  async leaveFor(target: GhostIdentity, raiseEvent: boolean): Promise<string | undefined> {
    if (this.closing || this.destroyed) return undefined;
    this.closing = true;
    this.player.abort();
    let value: string | undefined;
    if (raiseEvent) {
      value = await this.request('GET', 'OnGhostChanging', [target.sakuraName, 'manual', target.name, target.path]);
      if (!value) value = await this.request('GET', 'OnClose', ['user']);
      if (value) await this.playScript(value);
    }
    // 切り替えは終了ではないので、ほかのゴーストには OnOtherGhostClosed ではなく OnOtherGhostChanged を送る (切り替え先から)
    await this.destroy({ silent: true });
    return value ?? '';
  }

  private async finishClose(): Promise<void> {
    await new Promise((r) => setTimeout(r, CLOSE_GRACE_MS));
    await this.destroy();
  }

  /**
   * @param opts.silent ほかのゴーストに OnOtherGhostClosed を送らない (切り替え・再起動)
   * @param opts.failedBoot 起動に失敗した後始末。起動していないので、ほかのゴーストには何も知らせない
   */
  async destroy(opts: { silent?: boolean; failedBoot?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    this.player.abort();
    clearInterval(this.secondTimer);
    clearTimeout(this.balloonTimer);
    clearTimeout(this.restoreTimer);
    for (const t of this.namedTimers.values()) clearTimeout(t);
    this.namedTimers.clear();
    this.afterScript = [];
    this.sounds.forEach((s) => s.pause());
    this.env.closeInput(this);
    try {
      await this.shiori?.unload();
    } catch (e) {
      console.warn(`[${this.name}] unload`, e);
    }
    for (const s of this.scopes.values()) {
      s.view.destroy();
      s.balloon.destroy();
    }
    this.scopes.clear();
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.env.closed(this);
    if (opts.failedBoot) {
      this.changeNotice = undefined;
      return;
    }
    // あいさつの前に終わった切り替えも、切り替わったことは先に知らせる
    this.flushChangeNotice();
    if (opts.silent) return;
    const refs = [this.sakuraName, this.lastScript, this.name, '', '', '', '', this.shell?.name ?? ''];
    for (const g of this.env.others(this)) void g.raise('OnOtherGhostClosed', refs);
  }

  // ---------------------------------------------------------------- SHIORI

  async request(method: ShioriMethod, id: string, references: Reference[] = []): Promise<string | undefined> {
    if (this.destroyed || !this.shiori) return undefined;
    const headers: Record<string, string> = {};
    if (this.player.playing) headers.Status = 'talking';
    else if (this.busy) headers.Status = 'choosing';
    try {
      const res = parseResponse(await this.shiori.request(buildRequest({ method, id, references, headers })));
      return res.value;
    } catch (e) {
      console.warn(`[${this.name}] ${id}:`, e);
      return undefined;
    }
  }

  notify(id: string, references: Reference[] = []): Promise<string | undefined> {
    return this.request('NOTIFY', id, references);
  }

  /** イベントを送り、返ってきたスクリプトを再生する。再生したスクリプトを返す。 */
  async raise(id: string, references: Reference[] = [], opts: RaiseOptions = {}): Promise<string | undefined> {
    if (this.leaving) return undefined;
    const value = await this.request(opts.method ?? 'GET', id, references);
    if (!value || this.leaving) return undefined;
    if (opts.ifIdle && this.busy) return undefined;
    const played = this.playScript(value);
    if (opts.wait) await played;
    return value;
  }

  async playScript(script: string): Promise<void> {
    if (this.destroyed) return;
    const r = await this.player.play(script);
    if (r.aborted || this.destroyed) return;
    this.lastScript = script;
    if (r.exited) {
      if (!this.closing) {
        this.closing = true;
        await this.finishClose();
      }
      return;
    }
    this.runDeferred();
    if (!this.closing) this.armTimeouts(r, script);
  }

  /** スクリプトの後のタイムアウト。\* は選択肢のタイムアウトだけを止める */
  private armTimeouts(r: PlayResult, script: string): void {
    clearTimeout(this.balloonTimer);
    if (r.hasChoices) {
      const timeout = this.choiceTimeout ?? settings.choiceTimeout;
      if (r.noTimeout || timeout <= 0) return;
      this.balloonTimer = window.setTimeout(() => {
        this.closeBalloons();
        void this.raise('OnChoiceTimeout', [script]);
        this.armRestore();
      }, timeout);
      return;
    }
    const timeout = this.balloonTimeout ?? settings.balloonTimeout;
    if (timeout > 0) {
      this.balloonTimer = window.setTimeout(() => {
        this.closeBalloons();
        void this.raise('OnBalloonTimeout', [script], { ifIdle: true });
        this.armRestore();
      }, timeout);
    } else {
      // 自動で閉じないバルーンは、OnSurfaceRestore の時まで出しておく
      this.armRestore(true);
    }
  }

  /** バルーンが閉じてから一定時間後に OnSurfaceRestore を送る。新しいスクリプトが始まれば取り消す */
  private armRestore(closeBalloons = false): void {
    clearTimeout(this.restoreTimer);
    this.restoreTimer = window.setTimeout(() => {
      if (this.busy) return;
      if (closeBalloons) this.closeBalloons();
      void this.raise('OnSurfaceRestore', [this.surfaceOf(0), this.surfaceOf(1)], { ifIdle: true });
    }, RESTORE_DELAY_MS);
  }

  /** 再生中のスクリプトがあれば、それが終わってから fn を実行する */
  private defer(fn: () => void): void {
    if (this.player.playing) this.afterScript.push(fn);
    else fn();
  }

  private runDeferred(): void {
    const queue = this.afterScript;
    this.afterScript = [];
    queue.forEach((fn) => fn());
  }

  /** SHIORI のリソース (sakura.recommendsites など) */
  async sites(id: string): Promise<Site[]> {
    const value = await this.request('GET', id);
    if (!value) return [];
    return value
      .split('\x02')
      .map((row) => row.split('\x01'))
      .filter((cols) => cols[0])
      .map(([title, url = '']) => ({ title, url }));
  }

  // ---------------------------------------------------------------- 表示

  surfaceOf(scope: number): number {
    return this.scopes.get(scope)?.renderer.surfaceId ?? -1;
  }

  private scope(index: number): Scope {
    let s = this.scopes.get(index);
    if (s) return s;
    const renderer = new SurfaceRenderer(this.shell, index);
    renderer.bindEnabled = (id) => this.dressup.get(index)?.has(id) ?? false;
    renderer.defaultSurface = () => {
      const id = this.defaultSurface(index);
      return id < 0 ? id : (this.shell.resolve(index, String(id)) ?? id);
    };
    const balloon = new BalloonView(this.env.desktop, index === 0 ? 's' : 'k', index);
    balloon.setSkin(this.skin);
    balloon.setScale(settings.scale);
    balloon.onClick = () => this.onBalloonClick();
    const view = new CharacterView(index, renderer, this.env.characters, {
      click: (e) => void this.onMouse('OnMouseClick', e),
      doubleClick: (e) => void this.onMouse('OnMouseDoubleClick', e),
      move: (e) => void this.onMouse('OnMouseMove', e, true),
      wheel: (e) => void this.onMouse('OnMouseWheel', e),
      enter: (e) => void this.onMouse('OnMouseEnter', e, true),
      leave: (e) => void this.onMouse('OnMouseLeave', e, true),
      contextMenu: (e) => this.env.openMenu(this, e.clientX, e.clientY),
      moved: () => this.savePositions(),
      layout: () => this.layoutBalloon(index),
      pointerDown: () => this.env.focus(this),
    });
    view.scale = settings.scale;
    view.freeMove = this.freeMove();
    s = { renderer, view, balloon };
    this.scopes.set(index, s);
    return s;
  }

  private freeMove(): boolean {
    return this.shell.descript.str('seriko.alignmenttodesktop', this.descript.str('seriko.alignmenttodesktop')) === 'free';
  }

  /** 毎フレーム (GhostManager の rAF から) */
  tick(now: number): void {
    for (const s of this.scopes.values()) s.renderer.tick(now);
  }

  relayout(): void {
    for (const s of this.scopes.values()) {
      s.view.scale = settings.scale;
      s.balloon.setScale(settings.scale);
      s.view.clamp();
      s.view.layout();
    }
  }

  private place(index: number): void {
    const s = this.scopes.get(index);
    if (!s || s.view.placed || !s.renderer.visible) return;
    const saved = this.state.positions?.[index];
    if (saved) {
      s.view.right = saved.right;
      s.view.bottom = saved.bottom;
      s.view.placed = true;
      s.view.clamp();
      s.view.layout();
      return;
    }
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    // 右端から sakura、その左に kero、さらに左に char2… と並べる。他のゴーストがいればその左に
    let left = dw - 24;
    for (const g of this.env.others(this)) left = Math.min(left, g.leftEdge() - 24);
    for (let i = 0; i < index; i++) {
      const prev = this.scopes.get(i);
      if (prev?.renderer.visible) left = Math.min(left, prev.view.rect().left - 16);
    }
    s.view.setCenter(Math.max(s.view.width / 2, left - s.view.width / 2), dh);
  }

  /** 表示中のキャラクターのうち一番左の端 (デスクトップ座標) */
  leftEdge(): number {
    let left = this.env.desktop.clientWidth;
    for (const s of this.scopes.values()) if (s.renderer.visible && s.view.placed) left = Math.min(left, s.view.rect().left);
    return left;
  }

  private savePositions(): void {
    const positions: Record<number, { right: number; bottom: number }> = {};
    for (const [i, s] of this.scopes) if (s.view.placed) positions[i] = { right: s.view.right, bottom: s.view.bottom };
    this.state.positions = positions;
    saveSettings();
    for (const i of this.scopes.keys()) this.layoutBalloon(i);
  }

  /**
   * バルーンを置く。sakura は左、それ以外は右を優先し (SSP と同じ)、
   * 画面に収まらないか、同じゴーストの他のキャラクターに被るときは反対側にする。
   */
  private layoutBalloon(index: number): void {
    const s = this.scopes.get(index);
    if (!s || !s.balloon.shown) return;
    const b = s.balloon;
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    const r = s.view.rect();
    const prefix = Shell.scopePrefix(index);
    const ox = this.shell.descript.num(`${prefix}.balloon.offsetx`, 0) * settings.scale;
    const oy = this.shell.descript.num(`${prefix}.balloon.offsety`, 0) * settings.scale;
    const others = [...this.scopes]
      .filter(([i, o]) => i !== index && o.renderer.visible)
      .map(([, o]) => o.view.rect());
    const box = (right: boolean) => {
      b.setSide(right);
      const x = right ? r.left + r.width - ox : r.left - b.width + ox;
      const y = Math.min(Math.max(0, r.top + oy), Math.max(0, dh - b.height));
      return { right, x, y, w: b.width, h: b.height };
    };
    const fits = (c: ReturnType<typeof box>) => c.x >= 0 && c.x + c.w <= dw;
    const clear = (c: ReturnType<typeof box>) =>
      !others.some((o) => c.x < o.left + o.width && o.left < c.x + c.w && c.y < o.top + o.height && o.top < c.y + c.h);
    const preferRight = index !== 0;
    const candidates = [box(preferRight), box(!preferRight)];
    const pick = candidates.find((c) => fits(c) && clear(c)) ?? candidates.find(fits) ?? candidates[0];
    b.setSide(pick.right);
    b.moveTo(Math.min(Math.max(0, pick.x), Math.max(0, dw - pick.w)), pick.y);
  }

  closeBalloons(): void {
    clearTimeout(this.balloonTimer);
    for (const s of this.scopes.values()) {
      s.balloon.hide();
      s.balloon.clear();
    }
  }

  // ---------------------------------------------------------------- シェル・バルーン・着せ替え

  /**
   * シェルを切り替える。スクリプトから (\![change,shell]) のときは、--option=raise-event が無ければ
   * OnShellChanging を送らず、OnShellChanged はそのスクリプトが終わってから送る。
   */
  async changeShell(dir: string, opts: { fromScript?: boolean; raiseEvent?: boolean } = {}): Promise<void> {
    if (!this.shellDirs.includes(dir) || dir === this.shell.dir) return;
    const next = Shell.fromGhost(this.files, dir);
    const path = `shell/${dir}`;
    if (!opts.fromScript || opts.raiseEvent) {
      const value = await this.request('GET', 'OnShellChanging', [next.name, this.shell.name, path]);
      if (value) await this.playScript(value);
    }
    if (this.destroyed) return;
    this.shell = next;
    this.state.shell = dir;
    this.loadDressup();
    // 全員を一度に新しいシェルへ (途中で来た \s が、まだ古いシェルのキャラクターに行かないように)
    const switching = [...this.scopes].map(([i, s]) => ({ i, s, done: s.renderer.setShell(next) }));
    for (const { i, s, done } of switching) {
      const ok = await done;
      // 読み込みを待つ間に、さらに別のシェルへの切り替えが始まった
      if (this.shell !== next || this.destroyed) return;
      s.view.freeMove = this.freeMove();
      // 新しいシェルに同じサーフェスが無ければ既定のサーフェスにする
      if (!ok) await this.setSurface(i, String(this.defaultSurface(i)));
      // 新しいシェルへの読み込みが終わってから、それでも何も出せていなければ隠す (古いシェルの絵を残さない)
      await s.renderer.settled(next);
      if (this.shell !== next || this.destroyed) return;
      if (s.renderer.strandedIn(next)) await s.renderer.setSurface(-1);
      // 起動直後で、まだ置かれていなかったキャラクターもここで置く
      this.place(i);
      s.view.layout();
    }
    if (this.shell !== next) return;
    saveSettings();
    const changed = () => void this.raise('OnShellChanged', [next.name, this.name, path]);
    if (opts.fromScript) this.defer(changed);
    else changed();
  }

  async changeBalloon(key: string | null, opts: { fromScript?: boolean } = {}): Promise<void> {
    this.skin = await this.env.loadBalloon(key);
    if (this.destroyed) return;
    this.state.balloon = key ?? undefined;
    saveSettings();
    for (const [i, s] of this.scopes) {
      s.balloon.setSkin(this.skin);
      this.layoutBalloon(i);
    }
    const changed = () => void this.raise('OnBalloonChange', [this.skin.name, key ?? '']);
    if (opts.fromScript) this.defer(changed);
    else changed();
  }

  bindGroups(scope: number) {
    return this.shell.bindGroups(scope).map((g) => ({ ...g, enabled: this.dressup.get(scope)?.has(g.id) ?? false }));
  }

  setDressup(scope: number, id: number, enabled?: boolean, fromScript = false): void {
    const group = this.shell.bindGroups(scope).find((g) => g.id === id);
    if (!group) return;
    const set = this.dressup.get(scope) ?? new Set<number>();
    const on = enabled ?? !set.has(id);
    if (on) set.add(id);
    else set.delete(id);
    this.dressup.set(scope, set);
    const dress = (this.state.dressup ??= {});
    dress[`${this.shell.dir}:${scope}`] = [...set];
    saveSettings();
    this.scopes.get(scope)?.renderer.invalidate();
    const changed = () => void this.raise('OnDressupChanged', [scope, group.part, on ? 1 : 0, group.category, fromScript ? 'script' : 'user']);
    if (fromScript) this.defer(changed);
    else changed();
  }

  private loadDressup(): void {
    this.dressup = new Map();
    for (const scope of [0, 1, 2, 3]) {
      const saved = this.state.dressup?.[`${this.shell.dir}:${scope}`];
      const groups = this.shell.bindGroups(scope);
      if (!groups.length) continue;
      this.dressup.set(scope, new Set(saved ?? groups.filter((g) => g.default).map((g) => g.id)));
    }
  }

  // ---------------------------------------------------------------- 入力イベント

  private async onMouse(id: string, e: CharacterMouseEvent, ifIdle = false): Promise<void> {
    if (!this.ready) return;
    await this.raise(id, [e.x, e.y, e.wheel, e.scope, e.collision, e.button, 'mouse'], { ifIdle });
  }

  private onBalloonClick(): void {
    this.env.focus(this);
    if (this.player.playing) {
      this.player.skip();
      return;
    }
    if ([...this.scopes.values()].some((s) => s.balloon.hasChoices)) return;
    this.closeBalloons();
    void this.raise('OnBalloonClose', [this.lastScript]).then((played) => {
      if (!played) this.armRestore();
    });
  }

  keyPress(key: string, code: number): void {
    if (!this.ready) return;
    void this.raise('OnKeyPress', [key, code]);
  }

  async communicate(): Promise<void> {
    const res = await this.openInput({ title: `「${this.sakuraName}」に話しかける`, kind: 'communicatebox' });
    if ('value' in res) await this.raise('OnCommunicate', ['user', res.value]);
    // ukadoc: 閉じられた場合は cancel (close / timeout は OnUserInputCancel の値)
    else await this.raise('OnCommunicateInputCancel', ['', 'cancel']);
  }

  private async openInput(req: InputRequest): Promise<InputResult> {
    this.inputs++;
    try {
      return await this.env.input(this, req);
    } finally {
      this.inputs--;
    }
  }

  private async onSecond(): Promise<void> {
    if (this.destroyed || this.secondBusy) return;
    this.elapsedSec++;
    for (const s of this.scopes.values()) s.renderer.secondTick(this.elapsedSec);
    this.secondBusy = true;
    try {
      const idle = Math.floor((Date.now() - this.env.lastInputAt()) / 1000);
      const refs = [Math.floor((Date.now() - this.bootedAt) / 3_600_000), this.mikire() ? 1 : 0, this.kasanari() ? 1 : 0, this.busy ? 0 : 1, idle];
      await this.raise('OnSecondChange', refs, { ifIdle: true });
      // タイマーのずれで :00 を飛ばしても取りこぼさないよう、分が変わったかで判定する
      const minute = new Date().getMinutes();
      if (minute !== this.lastMinute) {
        this.lastMinute = minute;
        await this.raise('OnMinuteChange', refs, { ifIdle: true });
      }
    } finally {
      this.secondBusy = false;
    }
  }

  private mikire(): boolean {
    const s = this.scopes.get(0);
    if (!s?.renderer.visible) return false;
    const r = s.view.rect();
    return r.left < 0 || r.left + r.width > this.env.desktop.clientWidth;
  }

  private kasanari(): boolean {
    const a = this.scopes.get(0);
    const b = this.scopes.get(1);
    if (!a?.renderer.visible || !b?.renderer.visible) return false;
    const r1 = a.view.rect();
    const r2 = b.view.rect();
    return r1.left < r2.left + r2.width && r2.left < r1.left + r1.width && r1.top < r2.top + r2.height && r2.top < r1.top + r1.height;
  }

  // ---------------------------------------------------------------- PlayerHost

  talkWait(): number {
    return settings.talkWait;
  }

  balloon(scope: number): BalloonView {
    return this.scope(scope).balloon;
  }

  showBalloon(scope: number): void {
    this.scope(scope).balloon.show();
    this.layoutBalloon(scope);
  }

  hideBalloon(scope: number): void {
    this.scopes.get(scope)?.balloon.hide();
  }

  setBalloonId(scope: number, id: number): void {
    this.scope(scope).balloon.setBalloon(id);
    this.layoutBalloon(scope);
  }

  beginScript(append: boolean): void {
    clearTimeout(this.balloonTimer);
    clearTimeout(this.restoreTimer);
    // \![set,balloontimeout] などはスクリプトごとに戻す (\C で続けるスクリプトも別のスクリプト)
    this.balloonTimeout = undefined;
    this.choiceTimeout = undefined;
    if (append) return;
    for (const s of this.scopes.values()) {
      s.balloon.hide();
      s.balloon.clear();
      s.balloon.setBalloon(0);
    }
  }

  async setSurface(scope: number, arg: string): Promise<void> {
    if (this.destroyed) return;
    const id = this.shell.resolve(scope, arg);
    if (id === undefined) return;
    const s = this.scope(scope);
    const ok = await s.renderer.setSurface(id);
    if (!ok || this.destroyed) return;
    this.place(scope);
    s.view.layout();
  }

  playAnimation(scope: number, id: number): void {
    this.scope(scope).renderer.play(id);
  }

  waitAnimation(scope: number, id: number): Promise<void> {
    return this.scope(scope).renderer.waitAnimation(id);
  }

  talkChar(scope: number): void {
    this.scopes.get(scope)?.renderer.talk();
  }

  yenE(): void {
    for (const s of this.scopes.values()) s.renderer.yenE();
  }

  envVar(name: string): string {
    const now = new Date();
    switch (name) {
      case 'month':
        return String(now.getMonth() + 1);
      case 'day':
        return String(now.getDate());
      case 'hour':
        return String(now.getHours());
      case 'minute':
        return String(now.getMinutes());
      case 'second':
        return String(now.getSeconds());
      case 'username':
        return this.userName || settings.userName;
      case 'selfname':
        return this.sakuraName;
      case 'selfname2':
        return this.descript.str('sakura.name2', this.sakuraName);
      case 'keroname':
        return this.keroName;
      case 'screenwidth':
        return String(this.env.desktop.clientWidth);
      case 'screenheight':
        return String(this.env.desktop.clientHeight);
      case 'exh':
      case 'et':
        return String(Math.floor((Date.now() - this.bootedAt) / 3_600_000));
      case 'wronghour':
        return String((now.getHours() + 1 + Math.floor(Math.random() * 22)) % 24);
      case 'lastghostname':
        return this.previous?.name ?? '';
    }
    if (name.startsWith('property:')) return this.property(name.slice(9));
    return '';
  }

  /** SSP のプロパティシステムのうちよく使うもの */
  property(path: string): string {
    const p = path.trim().toLowerCase();
    const now = new Date();
    const ghosts = this.env.installed().filter((m) => m.kind === 'ghost');
    const fixed: Record<string, string | number> = {
      'baseware.name': BASEWARE_NAME,
      'baseware.version': BASEWARE_VERSION,
      'currentghost.name': this.name,
      'currentghost.sakuraname': this.sakuraName,
      'currentghost.keroname': this.keroName,
      'currentghost.craftman': this.descript.str('craftman'),
      'currentghost.craftmanw': this.descript.str('craftmanw'),
      'currentghost.path': this.key,
      'currentghost.shelllist.count': this.shellDirs.length,
      'currentghost.shelllist.current.name': this.shell.name,
      'currentghost.shelllist.current.path': `shell/${this.shell.dir}`,
      'currentghost.balloon.name': this.skin.name,
      'ghostlist.count': ghosts.length,
      'activeghostlist.count': this.env.others(this).length + 1,
      'system.year': now.getFullYear(),
      'system.month': now.getMonth() + 1,
      'system.day': now.getDate(),
      'system.hour': now.getHours(),
      'system.minute': now.getMinutes(),
      'system.second': now.getSeconds(),
      'system.dayofweek': now.getDay(),
    };
    if (p in fixed) return String(fixed[p]);
    let m = /^currentghost\.scope\((\d+)\)\.(surface\.num|x|y|name)$/.exec(p);
    if (m) {
      const s = this.scopes.get(Number(m[1]));
      const field = m[2];
      if (field === 'name') return Number(m[1]) === 0 ? this.sakuraName : Number(m[1]) === 1 ? this.keroName : '';
      if (!s) return '';
      if (field === 'surface.num') return String(s.renderer.surfaceId);
      const r = s.view.rect();
      return String(Math.round(field === 'x' ? r.left : r.top));
    }
    m = /^ghostlist\((\d+)\)\.(name|path)$/.exec(p);
    if (m) {
      const g = ghosts[Number(m[1])];
      return g ? (m[2] === 'name' ? g.name : g.key) : '';
    }
    return '';
  }

  /** 選択肢。再生中のスクリプトは止める (そうしないと残りの文字がバルーンを出し直す) */
  selectChoice(title: string, id: string, refs: string[]): void {
    this.player.abort();
    this.closeBalloons();
    if (id.startsWith('script:')) {
      void this.playScript(id.slice(7));
      return;
    }
    void (async () => {
      const played = /^On/.test(id)
        ? await this.raise(id, refs)
        : ((await this.raise('OnChoiceSelectEx', [title, id, ...refs])) ?? (await this.raise('OnChoiceSelect', [id, ...refs])));
      if (!played) this.armRestore();
    })();
  }

  /** アンカー。On で始まる ID はそのイベント、それ以外は OnAnchorSelectEx → OnAnchorSelect。URL は最後に開く */
  selectAnchor(title: string, id: string, refs: string[]): void {
    if (/^On/.test(id)) {
      void this.raise(id, refs);
      return;
    }
    void (async () => {
      const played = (await this.raise('OnAnchorSelectEx', [title, id, ...refs])) ?? (await this.raise('OnAnchorSelect', [id, ...refs]));
      if (!played && /^https?:\/\//i.test(id)) this.openUrl(id);
    })();
  }

  async command(a: string[], scope: number): Promise<void> {
    const arg = a.map((s) => s.trim());
    const cmd = (arg[0] ?? '').toLowerCase();
    const sub = (arg[1] ?? '').toLowerCase();
    const raiseEvent = arg.some((x) => x.toLowerCase() === '--option=raise-event');
    switch (cmd) {
      case 'raise':
        if (arg[1]) void this.raise(arg[1], arg.slice(2));
        return;
      case 'notify':
        if (arg[1]) void this.notify(arg[1], arg.slice(2));
        return;
      case 'timerraise':
      case 'timernotify': {
        // \![timerraise,ms,繰り返し,イベント,r0…]。同じイベント名は上書きし、ms が 0 なら取り消す。
        // 繰り返しは 0 で毎回、1 以上で1回だけ
        const event = arg[3];
        if (!event) return;
        const ms = Number(arg[1]) || 0;
        const repeat = Number(arg[2]) || 0;
        const refs = arg.slice(4);
        clearTimeout(this.namedTimers.get(event));
        this.namedTimers.delete(event);
        if (ms <= 0) return;
        const fire = () => {
          if (this.destroyed) return;
          if (repeat === 0) this.namedTimers.set(event, window.setTimeout(fire, ms));
          else this.namedTimers.delete(event);
          if (cmd === 'timerraise') void this.raise(event, refs);
          else void this.notify(event, refs);
        };
        this.namedTimers.set(event, window.setTimeout(fire, ms));
        return;
      }
      case 'change':
        if (sub === 'ghost' && arg[2]) this.env.changeGhost(this, arg[2], raiseEvent);
        else if (sub === 'shell' && arg[2]) await this.changeShellByName(arg[2], raiseEvent);
        else if (sub === 'balloon' && arg[2]) await this.changeBalloonByName(arg[2]);
        return;
      case 'call':
        if (sub === 'ghost' && arg[2]) this.env.callGhost(this, arg[2]);
        return;
      case 'open':
        if (sub === 'browser' && arg[2]) this.openUrl(arg[2]);
        else if (sub === 'mailer' && arg[2]) this.openUrl(`mailto:${arg[2]}`);
        else if (sub === 'communicatebox') this.openCommunicate();
        else if (sub === 'inputbox' || sub === 'passwordinput') void this.inputBox(arg[2] ?? '', arg[3], arg[4], sub === 'passwordinput');
        return;
      case 'close':
        if (sub === 'inputbox' || sub === 'communicatebox') this.env.closeInput(this, { kind: sub, id: arg[2] });
        return;
      case 'set':
        if (sub === 'balloontimeout' || sub === 'choicetimeout') {
          // 省略で既定に戻す、0 以下でタイムアウトしない。そのスクリプトの間だけ有効
          const raw = arg[2];
          let value: number | undefined;
          if (raw !== undefined && raw !== '') {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            value = n <= 0 ? 0 : n;
          }
          if (sub === 'balloontimeout') this.balloonTimeout = value;
          else this.choiceTimeout = value;
        }
        return;
      case 'bind': {
        // \![bind,カテゴリ,パーツ,1/0]
        const group = this.shell.bindGroups(scope).find((g) => g.category === arg[1] && (g.part === arg[2] || !arg[2]));
        if (group) this.setDressup(scope, group.id, arg[3] === undefined ? undefined : arg[3] === '1' || arg[3] === 'true', true);
        return;
      }
      case 'anim': {
        const r = this.scope(scope).renderer;
        const id = Number(arg[2]);
        if (sub === 'start' || sub === 'play') r.play(id);
        else if (sub === 'stop' || sub === 'clear') r.clear(id);
        return;
      }
      case 'sound':
        if (sub === 'play' || sub === 'loop') this.playSound(arg[2] ?? '', sub === 'loop');
        else if (sub === 'stop') this.stopSounds();
        return;
      case 'get':
        if (sub === 'property' && arg[2]) void this.raise(arg[2], arg.slice(3).map((p) => this.property(p)));
        return;
      case 'vanishbymyself':
        // 削除はユーザーがメニューから行う。ここでは終了のみ
        console.info(`[${this.name}] vanishbymyself は終了として扱います`);
        void this.close('vanish');
        return;
      default:
        console.debug(`[${this.name}] 未対応のコマンド \\![${arg.join(',')}]`);
    }
  }

  private async changeShellByName(name: string, raiseEvent: boolean): Promise<void> {
    const dir = this.shellDirs.find((d) => d === name.toLowerCase() || Shell.fromGhost(this.files, d).name === name);
    if (dir) await this.changeShell(dir, { fromScript: true, raiseEvent });
  }

  /** 見つからないバルーン名は無視する (ユーザーの選んだバルーンを消さない) */
  private async changeBalloonByName(name: string): Promise<void> {
    if (name === '内蔵バルーン') {
      await this.changeBalloon(null, { fromScript: true });
      return;
    }
    const b = this.env.installed().find((p) => p.kind === 'balloon' && (p.name === name || p.dir === name.toLowerCase()));
    if (b) await this.changeBalloon(b.key, { fromScript: true });
  }

  /**
   * \![open,inputbox,ID,timeout,text]。ID が On で始まればそのイベント (Reference0 = 入力) を、
   * それ以外は OnUserInput を送る。閉じた・時間切れは OnUserInputCancel (Reference1 = close / timeout)。
   */
  private async inputBox(id: string, timeout: string | undefined, text: string | undefined, password: boolean): Promise<void> {
    const res = await this.openInput({ title: this.sakuraName, kind: 'inputbox', id, defaultText: text, password, timeout: Number(timeout) || 0 });
    if ('value' in res) {
      if (/^On/.test(id)) await this.raise(id, [res.value]);
      else await this.raise('OnUserInput', [id, res.value]);
      return;
    }
    const played = await this.raise('OnUserInputCancel', [id, res.cancelled]);
    if (!played && res.cancelled === 'timeout') await this.raise('OnUserInput', [id, 'timeout']);
  }

  openCommunicate(): void {
    void this.communicate();
  }

  private ghostFile(path: string): { path: string; data: Uint8Array } | undefined {
    for (const p of [joinPath('ghost/master', path), normalizePath(path)]) {
      const data = this.files.get(p);
      if (data) return { path: p, data };
    }
    return undefined;
  }

  private blobUrl(path: string): string | undefined {
    const f = this.ghostFile(path);
    if (!f) return undefined;
    let url = this.blobUrls.get(f.path);
    if (!url) {
      url = URL.createObjectURL(new Blob([f.data as BlobPart]));
      this.blobUrls.set(f.path, url);
    }
    return url;
  }

  /** いまのシェルのフォルダにあるファイルの URL (メニューの画像など) */
  shellFileUrl(path: string): string | undefined {
    const p = joinPath(`shell/${this.shell.dir}`, normalizePath(path));
    const data = this.files.get(p);
    if (!data) return undefined;
    let url = this.blobUrls.get(p);
    if (!url) {
      url = URL.createObjectURL(new Blob([data as BlobPart]));
      this.blobUrls.set(p, url);
    }
    return url;
  }

  /** SHIORI (や SAORI) が書いたファイルを、表示に使う写しとセーブデータの両方に入れる */
  private saveFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
    // 書き換えられた画像などは、作ってあった URL を作り直す
    const url = this.blobUrls.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      this.blobUrls.delete(path);
    }
    void writePackageFile(this.key, normalizePath(path), data).catch((e) => console.warn('[save]', e));
  }

  /** SAORI に頼まれたこと (Worker からは触れないもの) */
  private onSaori(effect: SaoriEffect): void {
    if (effect.kind === 'clipboard') {
      void copyText(effect.text);
    } else if (effect.kind === 'sound') {
      const data = effect.data ?? this.files.get(effect.path);
      if (data) this.playAudio(URL.createObjectURL(new Blob([data as BlobPart])), false, true);
    } else if (effect.kind === 'write') {
      this.saveFile(effect.path, effect.data);
    }
  }

  playSound(file: string, loop = false): void {
    const url = this.blobUrl(file);
    if (url) this.playAudio(url, loop, false);
  }

  /** revoke なら、鳴り終わったら URL を捨てる (その場で作った URL) */
  private playAudio(url: string, loop: boolean, revoke: boolean): void {
    const audio = new Audio(url);
    audio.loop = loop;
    this.sounds.push(audio);
    const forget = () => {
      this.sounds = this.sounds.filter((s) => s !== audio);
      if (revoke) URL.revokeObjectURL(url);
    };
    audio.addEventListener('ended', forget);
    audio.addEventListener('error', forget);
    void audio.play().catch(forget);
  }

  private stopSounds(): void {
    this.sounds.forEach((s) => s.pause());
    this.sounds = [];
  }

  /** 再生中の (ループでない) 音が終わるまで。止められた・再生できなかった音は待たない */
  waitSound(): Promise<void> {
    const playing = this.sounds.filter((s) => !s.paused && !s.ended && !s.error && !s.loop);
    return Promise.all(
      playing.map(
        (s) =>
          new Promise<void>((resolve) => {
            for (const ev of ['ended', 'error', 'pause', 'emptied']) s.addEventListener(ev, () => resolve(), { once: true });
          }),
      ),
    ).then(() => {});
  }

  openUrl(url: string): void {
    if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank', 'noopener');
  }

  /** \_b の画像。伺かの透過規則 (左上の色・.pna) を当ててから URL にする */
  async imageUrl(path: string, opts: InlineImageOptions): Promise<string | undefined> {
    const f = this.ghostFile(path);
    if (!f) return undefined;
    const key = `${f.path}|${opts.alpha}`;
    const cached = this.blobUrls.get(key);
    if (cached) return cached;
    try {
      const pna = opts.alpha === 'none' ? undefined : this.files.get(f.path.replace(/\.[^./]+$/, '') + '.pna');
      const canvas = await loadTransparentImage(f.data, pna, opts.alpha);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob || this.destroyed) return undefined;
      const url = URL.createObjectURL(blob);
      this.blobUrls.set(key, url);
      return url;
    } catch (e) {
      console.warn(`[${this.name}] \\_b ${path}:`, e);
      return undefined;
    }
  }
}
