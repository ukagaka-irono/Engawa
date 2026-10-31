import { zipSync } from 'fflate';
import { BalloonView } from '../balloon/balloon-view';
import type { BalloonSkin } from '../balloon/skin';
import { Descript } from '../package/descript';
import type { SaoriEffect } from '../saori/context';
import { ScriptPlayer, type InlineImage, type InlineImageOptions, type PlayerHost, type PlayResult } from '../sakura/player';
import { buildRequest, parseResponse, type Reference, type ShioriMethod } from '../shiori/protocol';
import { createShiori, type Shiori } from '../shiori/shiori';
import { UnsupportedShiori } from '../shiori/unsupported-shiori';
import type { CharacterLayer } from '../shell/character-layer';
import { CharacterView, type Alignment, type CharacterMouseEvent } from '../shell/character-view';
import { SurfaceRenderer } from '../shell/renderer';
import { Shell } from '../shell/shell';
import { closeSystemDialogs, download, hideTooltip, openSystemDialog, showTooltip } from '../ui/ghost-ui';
import { copyText } from '../util/clipboard';
import { loadTransparentImage } from '../util/image';
import { AudioTap } from '../util/audio-tap';
import { md5 } from '../util/md5';
import { filesFromZip } from '../vfs/archive';
import { joinPath, normalizePath, type FileTree } from '../vfs/files';
import { writePackageFile, type PackageMeta } from '../vfs/storage';
import type { GhostListEntry } from './ghostlist';
import { httpEvent, httpFileName, nofileText, parseFeed, parseHttp, runHttp, type HttpRequest } from './http';
import { seekTime } from './sound-options';
import { calendarRefs, parseICal, parseScheduleDate, type CalEvent } from './ical';
import { moveTarget, parseMove, type Rect } from './move';
import { rateOfUse, readProperty, writeProperty, type LogEntry, type PropertyHost, type SoundInfo } from './properties';
import { addHistory, ghostState, saveSettings, settings, type GhostState } from './settings';
import { randomWord } from './words';

export const BASEWARE_NAME = 'Engawa';
export const BASEWARE_VERSION = '0.1.0';

export type BootMode =
  | { kind: 'boot' }
  /** 切り替え。script は前のゴーストの切り替え時のスクリプト、fromShell はそのシェル名 */
  | { kind: 'changed'; from: GhostIdentity; script: string; fromShell: string }
  | { kind: 'called'; from: GhostIdentity }
  /** ネットワーク更新・\![reload,ghost] の後の読み直し */
  | { kind: 'reload' }
  /** 消滅したゴーストの後に起動した (OnVanished を送る)。script は消えたゴーストの OnVanishSelected のスクリプト */
  | { kind: 'vanished'; from: GhostIdentity; script: string };

export interface GhostIdentity {
  name: string;
  sakuraName: string;
  path: string;
}

export type InputKind = 'inputbox' | 'communicatebox' | 'teachbox' | 'textareabox' | 'dateinput' | 'timeinput' | 'sliderinput' | 'ipinput';

export interface InputRequest {
  title: string;
  /** \![close,inputbox,ID] / \![close,communicatebox] で閉じる対象を選ぶため */
  kind: InputKind;
  id?: string;
  /** 入力欄の形 (InputBox の type) */
  type?: 'text' | 'password' | 'textarea' | 'date' | 'time' | 'slider' | 'ip';
  defaultText?: string;
  values?: number[];
  min?: number;
  max?: number;
  placeholder?: string;
  limit?: number;
  /** 入力の候補 (inputbox.autocomplete) */
  suggestions?: string[];
  password?: boolean;
  timeout?: number;
  noClose?: boolean;
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
  /** 重ねたときに見せる画像 (3つ目の欄) */
  thumbnail?: string;
}

/** ベースウェアの道具 (\![open,…] で開くもの) */
export type ToolName =
  | 'readme'
  | 'terms'
  | 'help'
  | 'configurationdialog'
  | 'ghostexplorer'
  | 'shellexplorer'
  | 'balloonexplorer'
  | 'dressupexplorer'
  | 'pluginexplorer'
  | 'headlinesensorexplorer'
  | 'rateofusegraph'
  | 'rateofusegraphballoon'
  | 'rateofusegraphtotal'
  | 'developer'
  | 'surfacetest'
  | 'shiorirequest'
  | 'errorlog'
  | 'backlogviewer'
  | 'aigraph'
  | 'addressbar'
  | 'archiveviewer'
  | 'pictureviewer'
  /** スクリプトを送るボックス (SSP の Script Input) */
  | 'sendbox';

/** ネットワーク更新の頼み。targets は ghost・shell・balloon と --balloon=名前・--shell=名前 */
export interface UpdateRequest {
  targets: string[];
  /** manual (メニュー) か script */
  reason: string;
  checkOnly?: boolean;
  testOnly?: boolean;
  recovery?: boolean;
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
  /** raiseEvent: OnGhostChanging を送るか (メニューからは常に、スクリプトからは --option=raise-event のときだけ)。target は名前か random・sequential・lastinstalled */
  changeGhost(from: Ghost, target: string, raiseEvent: boolean): void;
  callGhost(from: Ghost, target: string, raiseEvent?: boolean): void;
  focus(ghost: Ghost): void;
  closed(ghost: Ghost): void;
  input(ghost: Ghost, req: InputRequest): Promise<InputResult>;
  /** そのゴーストの入力ボックス (順番待ちを含む) を閉じる。filter が無ければすべて */
  closeInput(ghost: Ghost, filter?: InputFilter): void;
  /** 名前付きの同期オブジェクト (\![wait/set/reset,syncobject])。ページの中のゴーストどうしで共有する */
  sync(name: string, op: 'set' | 'reset' | 'wait', timeout?: number): Promise<void>;
  /** ベースウェアの画面を開く */
  openTool(ghost: Ghost, tool: ToolName, args: string[]): void;
  /** 通知 (トレイのバルーン)。クリックされたら true、時間切れ・閉じたら false */
  notify(ghost: Ghost, title: string, text: string, kind: string): Promise<boolean>;
  /** トレイ (タスクバー) のアイコンと文字。url が無ければ戻す */
  setTrayIcon(ghost: Ghost, url: string | undefined, text: string): void;
  /** 消滅 (アンインストール)。query なら確かめる */
  vanish(ghost: Ghost, opts: { next?: string; query?: boolean }): Promise<void>;
  /** ネットワーク更新 */
  update(ghost: Ghost, opts: UpdateRequest): Promise<void>;
  /** 読み直す (ghost・shell・balloon・descript・shiori) */
  reload(ghost: Ghost, what: string): Promise<void>;
  /** URL・ファイルからのインストール */
  installFrom(ghost: Ghost, url: string): Promise<void>;
  /** 最後にインストールしたもの (lastinstalled) */
  lastInstalled(kind: 'ghost' | 'balloon' | 'shell'): string | undefined;
  /** すべて閉じる */
  closeAll(reason: string): Promise<void>;
  /** ログ (開発用パレット・エラーログで見る) */
  log(ghost: Ghost, kind: 'request' | 'error' | 'script', text: string): void;
  /** 開発用パレット・エラーログ・プロパティ (developer.log) のログ */
  logs(kind: string): LogEntry[];
  /** 利用者への短い知らせ */
  toast(message: string): void;
  /** 起動時の、ブラウザとまわりの様子の NOTIFY (OnNetworkStatusChange・OnDarkTheme など) */
  environmentNotices(ghost: Ghost): Promise<void>;
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
  /** SHIORI に足すヘッダ (SSTP の Sender・SecurityLevel など) */
  headers?: Record<string, string>;
  /** OnTranslate・OnOtherGhostTalk の Reference に入れる種類 (communicate・sstp-send など) */
  kinds?: string[];
  /** トランスレートしない (SSTP の notranslate) */
  noTranslate?: boolean;
  /** Reference をログ (SHIORI リクエスト・developer.log) に残さない (パスワードの入力) */
  secret?: boolean;
}

/** スクリプトの由来 (OnOtherGhostTalk・OnTranslate・SSTP のマーカー用) */
interface ScriptContext {
  event?: string;
  refs?: Reference[];
  kinds?: string[];
  /** SSTP で受けた (送り主をバルーンに出す) */
  sstpSender?: string;
  /** トランスレートしない */
  noTranslate?: boolean;
}

/** 音1つ (\![sound,…]) */
interface Sound {
  name: string;
  audio: HTMLAudioElement;
  url: string;
  revoke: boolean;
  /** --balance・--spectrum を使うときだけ (Web Audio に通す) */
  tap?: AudioTap;
  balance?: number;
  /** --spectrum の知らせ */
  spectrum?: { timer: number; bands: number; peaks: number[]; bandPeaks: number[]; hold: number; heldAt: number };
}

const CLOSE_GRACE_MS = 800;
/** バルーンが閉じてから OnSurfaceRestore までの時間 (SSP と同じ) */
const RESTORE_DELAY_MS = 15_000;
/** \4 で離れる距離 */
const STEP_AWAY_PX = 64;

/** 「0,1;2,3」の形のグループ (sticky-window・zorder のプロパティ) */
function parseGroups(text: string): string[][] {
  return text
    .split(';')
    .map((g) =>
      g
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
    .filter((g) => g.length >= 2);
}

/** 同じスコープを2つのグループに入れない (後のものを捨てる) */
function uniqueGroups(groups: string[][]): string[][] {
  const used = new Set<string>();
  return groups.filter((g) => {
    if (g.some((x) => used.has(x))) return false;
    g.forEach((x) => used.add(x));
    return true;
  });
}

/**
 * よそのページ (別のオリジン) から SSTP で送られたスクリプトでは使えない \![…] ("コマンド,サブコマンド" で照合)。
 * ukadoc の SSTP の仕様のとおり、リモートからのものはタグに強い制約をかける。喋る・表情・選択肢などはそのまま使える。
 * ほかのゴーストやイベントを動かすもの、開く・実行する・消す・更新する・設定を変えるものを止める
 */
const REMOTE_BLOCKED =
  /^(raise|notify|raiseother|notifyother|timerraise|timernotify|timerraiseother|timernotifyother|change|call|open|execute|vanishbymyself|updatebymyself|update|updateother|reload|unload|load|executesntp|biff|create),|^set,(property|wallpaper|tasktrayicon|trayballoon)$/;

/** ファイル名から MIME タイプ (blob URL で開くときに要る) */
function mimeOf(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    cur: 'image/x-icon',
    ani: 'application/x-navi-animation',
    txt: 'text/plain; charset=utf-8',
    html: 'text/html',
    htm: 'text/html',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mid: 'audio/midi',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
  };
  return types[ext] ?? 'application/octet-stream';
}

/** 更新のオプション (checkonly・testonly・recovery) */
function updateOptions(args: string[]): Pick<UpdateRequest, 'checkOnly' | 'testOnly' | 'recovery'> {
  return { checkOnly: hasOption(args, 'checkonly'), testOnly: hasOption(args, 'testonly'), recovery: hasOption(args, 'recovery') };
}

/** Base64 をバイト列に (読めなければ空) */
function base64Bytes(s: string): Uint8Array {
  try {
    return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

function bytesBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function boolArg(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'enable';
}

/** --name=値 の形の引数 (大文字小文字は区別しない) */
function optionValue(args: string[], name: string): string | undefined {
  const prefix = `--${name.toLowerCase()}=`;
  return args.find((a) => a.trim().toLowerCase().startsWith(prefix))?.trim().slice(prefix.length);
}

function hasOption(args: string[], name: string): boolean {
  const n = name.toLowerCase();
  return args.some((a) => {
    const t = a.trim().toLowerCase();
    return t === `--${n}` || t === `--option=${n}` || t === n;
  });
}

/** 起動中のゴースト1体。SHIORI・シェル・バルーン・スクリプト再生をまとめる。 */
export class Ghost implements PlayerHost {
  readonly descript: Descript;
  readonly name: string;
  readonly sakuraName: string;
  readonly keroName: string;
  shell!: Shell;
  skin!: BalloonSkin;
  lastScript = '';
  /** SSTP の ID (uniqueid) */
  readonly uniqueId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  private shiori?: Shiori;

  /** 動かしている SHIORI の名前 (読み込めなかったものは UnsupportedShiori の説明) */
  get shioriName(): string {
    return this.shiori?.name ?? '';
  }
  /** \![unload,shiori] の後 */
  private shioriUnloaded = false;
  /** SHIORI が ErrorLevel で知らせたもの (同じものは1度だけログに書く) と、通知したか */
  private readonly reportedErrors = new Set<string>();
  private errorNotified = false;
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
  private lastHour = new Date().getHours();
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
  /** 開いている・順番待ちの入力ボックスの種類 (Status の opening(…)) */
  private readonly openInputs: string[] = [];
  private readonly blobUrls = new Map<string, string>();
  /** \![open,dialog,save] で返した download/ のパス (そこへ書かれたらダウンロードにする) */
  private readonly saveTargets = new Set<string>();
  private readonly sounds = new Map<string, Sound>();
  private userName?: string;
  private previous?: GhostIdentity;
  /**
   * 切り替えで起動したときの OnOtherGhostChanged。あいさつの後に送るが、その前に終わったら destroy で送る
   * (切り替わったこと自体は、ほかのゴーストに必ず知らせる)
   */
  private changeNotice?: string[];

  /** \t の間 (マウスのイベントを送らない) */
  private timeCritical = false;
  /** \![enter,…] のモード (passivemode・inductionmode・nouserbreakmode・collisionmode・selectmode) */
  private readonly modes = new Set<string>();
  /** \![set,otherghosttalk] */
  otherGhostTalk: 'false' | 'before' | 'after' = 'false';
  /** \![set,othersurfacechange] */
  otherSurfaceChange = false;
  /** \![moveasync] の取り消し用 */
  private readonly moving = new Set<{ cancelled: boolean }>();
  /** \![set,sticky-window] のグループ (スコープ番号) */
  private stickyGroups: string[][] = [];
  /** \![set,zorder] のグループ (手前から。s0 / b0 / 0) */
  private zorderGroups: string[][] = [];
  private stayOnTop = false;
  /** 最小化 (隠している) */
  private minimized = false;
  /** \![set,balloonalign] */
  private readonly balloonAligns = new Map<number, string>();
  /** \![set,balloonoffset] (@ 付きは相対) */
  private readonly balloonOffsets = new Map<number, { x: string; y: string }>();
  /** \![set,scaling] の倍率 (スコープごと) */
  private readonly scalings = new Map<number, { x: number; y: number }>();
  /** \![set,property,currentghost.scope(n).seriko.defaultsurface] */
  private readonly defaultSurfaces = new Map<number, number>();
  /** 再生中のスクリプトの由来 */
  private context: ScriptContext = {};

  /** 再生中のスクリプトが、よそのページから SSTP で送られたもの (REMOTE_BLOCKED の \![…] と \j は使えない) */
  private get fromRemote(): boolean {
    return !!this.context.kinds?.includes('remote');
  }
  /** 利用者がバルーンのダブルクリックで止めた (OnOtherGhostTalk の break) */
  private broken = false;
  /** マウスが乗っているスコープと当たり判定 (OnMouseEnterAll・OnMouseEnter 用) */
  private readonly hovered = new Map<number, string>();
  private lastOverlap = '';
  private lastOffscreen = '';
  private linkHoverTimer?: number;
  /** \![lock,balloonrepaint,manual] (スクリプトが終わっても解かない) */
  private balloonRepaintManual = false;
  /** 入力ボックスのうち teachbox の履歴 (OnTeach の Reference) */
  private teachHistory: string[] = [];

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
    return this.player.playing || this.openInputs.length > 0 || this.choosing;
  }

  private get choosing(): boolean {
    return [...this.scopes.values()].some((s) => s.balloon.shown && s.balloon.hasChoices);
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  /** 終了処理に入っている (OnClose・切り替え中) */
  get leaving(): boolean {
    return this.closing || this.destroyed;
  }

  /** パッシブモード (メニューから閉じる・切り替えることができない) */
  get passive(): boolean {
    return this.modes.has('passivemode');
  }

  get isMinimized(): boolean {
    return this.minimized;
  }

  /** \t の間 (SSTP で割り込めない) */
  get locked(): boolean {
    return this.timeCritical;
  }

  private defaultSurface(scope: number): number {
    const set = this.defaultSurfaces.get(scope);
    if (set !== undefined) return set;
    const fallback = scope === 0 ? 0 : scope === 1 ? 10 : -1;
    return this.descript.num(`${Shell.scopePrefix(scope)}.seriko.defaultsurface`, fallback);
  }

  /** ゴーストの descript とシェルの descript のどちらか (シェルが優先) */
  private setting(key: string): string {
    return this.shell?.descript.str(key, this.descript.str(key)) ?? this.descript.str(key);
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

    const shiori = await this.loadShiori();
    // 読み込みの間に閉じられた。起動イベントは送らず、ここで読み込んだ SHIORI を片付ける
    if (this.leaving) {
      await shiori.unload();
      return;
    }
    this.shiori = shiori;
    await this.notify('OnInitialize', mode.kind === 'reload' ? ['reload'] : []);
    await this.request('GET', 'version');
    await this.sendBootNotices();
    this.userName = await this.request('GET', 'username');
    if (this.leaving) return;

    // 既定の位置 (SHIORI の sakura.defaultx など) は、サーフェスを出す前に聞いておく
    await this.loadDefaultPositions();
    // kero は sakura の左に並べるので、sakura の大きさが決まってから置く
    await this.setSurface(0, String(this.defaultSurface(0)));
    if (this.destroyed) return;
    await this.setSurface(1, String(this.defaultSurface(1)));
    if (this.destroyed) return;

    this.secondTimer = window.setInterval(() => void this.onSecond(), 1000);
    const firstBoot = !this.state.bootCount;
    this.state.bootCount = (this.state.bootCount ?? 0) + 1;
    this.state.lastBootAt = Date.now();
    saveSettings();
    this.ready = true;
    void this.bootTalk(mode, firstBoot);
  }

  private async loadShiori(): Promise<Shiori> {
    let shiori = createShiori(this.files, this.descript, {
      onWrite: (path, data) => this.saveFile(path, data, true),
      onLog: (m) => {
        console.info(`[${this.name}]`, m);
        this.env.log(this, 'error', m);
      },
      onSaori: (effect) => this.onSaori(effect),
    });
    try {
      await shiori.load();
    } catch (e) {
      console.error(`[${this.name}] SHIORI load failed`, e);
      this.env.log(this, 'error', `SHIORI の読み込みに失敗: ${(e as Error).message}`);
      shiori = new UnsupportedShiori(`${shiori.name} (読み込み失敗: ${(e as Error).message})`);
    }
    return shiori;
  }

  /** 起動時の NOTIFY (ukadoc の「NOTIFY」の順) */
  private async sendBootNotices(): Promise<void> {
    const all = this.env.installed();
    const ghosts = all.filter((p) => p.kind === 'ghost');
    const balloons = all.filter((p) => p.kind === 'balloon');
    await this.notify('basewareversion', [BASEWARE_VERSION, BASEWARE_NAME]);
    // ブラウザにはウインドウハンドルが無いので、キャラクターごとの仮の番号 (\x01 区切り)。
    // 空にすると、数を数えて分けるゴースト (kotori の notify.lua など) が止まる
    const windows = Array.from({ length: Math.max(2, this.scopes.size) }, (_, i) => i);
    await this.notify('hwnd', [windows.map((i) => 1 + i).join('\x01'), windows.map((i) => 101 + i).join('\x01')]);
    await this.notify('uniqueid', [this.uniqueId]);
    await this.notify('capability', ['request.status', 'request.securitylevel', 'request.sender', 'response.marker', 'response.errorlevel', 'response.errordescription']);
    await this.notify('ownerghostname', [this.sakuraName]);
    const others = this.env.others(this);
    await this.notify('otherghostname', others.map((g) => `${g.sakuraName}\x01${g.surfaceOf(0)}\x01${g.surfaceOf(1)}`));
    await this.notify('installedsakuraname', ghosts.map((p) => p.sakuraName ?? p.name));
    await this.notify('installedkeroname', ghosts.map(() => ''));
    await this.notify('installedghostname', ghosts.map((p) => p.name));
    await this.notify('installedballoonname', ['内蔵バルーン', ...balloons.map((p) => p.name)]);
    await this.notify('installedshellname', this.shellDirs.map((d) => Shell.fromGhost(this.files, d).name));
    await this.notify('ghostpathlist', ['/ghost/']);
    await this.notify('balloonpathlist', ['/balloon/']);
    await this.notify('rateofusegraph', rateOfUse(all).map((r) => [r.meta.name, r.meta.sakuraName ?? '', '', r.boots, r.minutes, r.percent.toFixed(2), this.env.others(this).some((g) => g.key === r.meta.key) || r.meta.key === this.key ? 'boot' : 'install'].join('\x01')));
    await this.notify('OnNotifySelfInfo', [this.name, this.sakuraName, this.keroName, this.shell.name, `/ghost/${this.key}/shell/${this.shell.dir}/`, this.skin.name, this.skin.key ?? '']);
    await this.notify('OnNotifyBalloonInfo', [this.skin.name, this.skin.key ?? '', `0:${[...Array(this.skin.count('s')).keys()].map((i) => i * 2).join(',')} 1:${[...Array(this.skin.count('k')).keys()].map((i) => i * 2).join(',')}`]);
    await this.notify('OnNotifyShellInfo', [this.shell.name, `/ghost/${this.key}/shell/${this.shell.dir}/`, readProperty('currentghost.seriko.surfacelist.all', this.propertyHost())]);
    await this.notifyDressup('NOTIFY');
    await this.notify('OnNotifyUserInfo', [settings.userName, settings.userName, '', 'undef']);
    await this.notify('OnNotifyOSInfo', [`Web,,${navigator.userAgent}`, `,${navigator.hardwareConcurrency ?? 1},`, '', Math.floor(performance.now() / 60000)]);
    await this.env.environmentNotices(this);
  }

  /** 着せ替えの情報 (OnNotifyDressupInfo)。起動時は NOTIFY、利用者の操作のときは GET */
  private async notifyDressup(method: ShioriMethod): Promise<void> {
    const rows: string[] = [];
    for (const scope of [0, 1, 2, 3]) {
      for (const g of this.bindGroups(scope)) rows.push([scope, g.category, g.part, '', g.enabled ? 1 : 0, ''].join('\x01'));
    }
    if (!rows.length) return;
    if (method === 'NOTIFY') await this.notify('OnNotifyDressupInfo', rows);
    else await this.raise('OnNotifyDressupInfo', rows);
  }

  /** SHIORI・descript の既定の位置 (sakura.defaultx / defaulty / defaultleft / defaulttop) */
  private readonly defaultPositions = new Map<number, { x?: number; y?: number; left?: number; top?: number }>();

  private async loadDefaultPositions(): Promise<void> {
    const parse = (v: string | undefined): number | undefined => {
      const t = (v ?? '').trim();
      if (!t) return undefined;
      // -0 は右端・下端、--100 は座標 -100 (負の値は右端・下端からの距離)
      if (t.startsWith('--')) return Number(t.slice(1));
      const n = Number(t);
      if (!Number.isFinite(n)) return undefined;
      return t.startsWith('-') ? -Math.abs(n) - 0.000001 : n;
    };
    for (const scope of [0, 1]) {
      const prefix = Shell.scopePrefix(scope);
      const get = async (k: string) => parse((await this.request('GET', `${prefix}.${k}`)) ?? this.setting(`${prefix}.${k}`));
      const pos = { x: await get('defaultx'), y: await get('defaulty'), left: await get('defaultleft'), top: await get('defaulttop') };
      if (Object.values(pos).some((v) => v !== undefined)) this.defaultPositions.set(scope, pos);
    }
  }

  /**
   * 起動イベント。再生し終わってから、他のゴーストに知らせる。
   * 呼び出されたときは呼び出し元に OnGhostCallComplete、ほかに OnOtherGhostBooted。
   * 切り替わったときはほかのゴーストに OnOtherGhostChanged。普通の起動 (前回の続きなど) では知らせない。
   */
  private async bootTalk(mode: BootMode, firstBoot: boolean): Promise<void> {
    let value: string | undefined;
    let event = 'OnBoot';
    let refs: Reference[] = [this.shell.name];
    if (mode.kind === 'changed') {
      this.previous = mode.from;
      event = 'OnGhostChanged';
      refs = [mode.from.sakuraName, mode.script, mode.from.name, mode.from.path];
      value = await this.request('GET', event, refs);
    } else if (mode.kind === 'called') {
      event = 'OnGhostCalled';
      refs = [mode.from.sakuraName, '', mode.from.name, mode.from.path];
      value = await this.request('GET', event, refs);
    } else if (mode.kind === 'vanished') {
      this.previous = mode.from;
      event = 'OnVanished';
      refs = [mode.from.sakuraName, mode.script, mode.from.name, '', '', '', '', this.shell.name];
      value = await this.request('GET', event, refs);
    } else if (mode.kind === 'reload') {
      // 読み直し: 起動のあいさつはしない
      return;
    } else if (firstBoot) {
      event = 'OnFirstBoot';
      refs = [0];
      value = await this.request('GET', event, refs);
    }
    if (!value) {
      event = 'OnBoot';
      refs = [this.shell.name];
      value = await this.request('GET', event, refs);
    }
    if (this.changeNotice) this.changeNotice[3] = value ?? '';
    if (value) await this.playScript(value, { event, refs });
    // 切り替わったこと自体は、あいさつの途中で閉じられても知らせる (閉じられたら destroy で送り済み)
    this.flushChangeNotice();
    if (this.leaving || mode.kind !== 'called') return;
    const done = [this.sakuraName, value ?? '', this.name, '', '', '', '', this.shell.name];
    for (const g of this.env.others(this)) void g.raise(g.key === mode.from.path ? 'OnGhostCallComplete' : 'OnOtherGhostBooted', done);
  }

  /** 送っていない OnOtherGhostChanged があれば、ほかのゴーストへ送る */
  private flushChangeNotice(): void {
    const refs = this.changeNotice;
    if (!refs) return;
    this.changeNotice = undefined;
    for (const g of this.env.others(this)) void g.raise('OnOtherGhostChanged', refs);
  }

  /** メニューの「閉じる」など。OnClose (すべて閉じるときは OnCloseAll) のスクリプトを再生してから終了する。 */
  async close(reason = 'user', all = false): Promise<void> {
    if (this.closing || this.destroyed) return;
    this.closing = true;
    this.player.abort();
    let value: string | undefined;
    let event = 'OnClose';
    if (all) {
      event = 'OnCloseAll';
      value = await this.request('GET', event, [reason, 0, 0]);
    }
    if (!value) {
      event = 'OnClose';
      value = await this.request('GET', event, [reason]);
    }
    if (value) await this.playScript(value, { event });
    await this.finishClose();
  }

  /**
   * 別のゴーストに切り替わる。OnGhostChanging (返事が無ければ OnClose) を再生して終了し、
   * 再生したスクリプトを返す (切り替え先の OnGhostChanged の Reference1)。既に終了処理中なら undefined。
   */
  async leaveFor(target: GhostIdentity, raiseEvent: boolean, cache = false): Promise<string | undefined> {
    if (this.closing || this.destroyed) return undefined;
    this.closing = true;
    this.player.abort();
    let value: string | undefined;
    if (raiseEvent) {
      value = await this.request('GET', 'OnGhostChanging', [target.sakuraName, 'manual', target.name, target.path]);
      if (!value) value = await this.request('GET', 'OnClose', ['user']);
      if (value) await this.playScript(value, { event: 'OnGhostChanging' });
    }
    // 切り替えは終了ではないので、ほかのゴーストには OnOtherGhostClosed ではなく OnOtherGhostChanged を送る (切り替え先から)。
    // ゴーストキャッシュを使うときは、終わらせずにしまっておく
    if (cache) await this.suspend();
    else await this.destroy({ silent: true });
    return value ?? '';
  }

  /** ゴーストキャッシュに入っている (隠して止めている) */
  private suspended = false;

  get isSuspended(): boolean {
    return this.suspended && !this.destroyed;
  }

  /** ゴーストキャッシュに入る。SHIORI はそのままに、隠して時計を止める (OnCacheSuspend) */
  private async suspend(): Promise<void> {
    this.player.abort();
    this.endScript();
    this.closeBalloons();
    clearInterval(this.secondTimer);
    clearTimeout(this.restoreTimer);
    clearTimeout(this.linkHoverTimer);
    for (const t of this.namedTimers.values()) clearTimeout(t);
    this.namedTimers.clear();
    for (const s of this.sounds.values()) this.stopSound(s, undefined);
    this.env.closeInput(this);
    this.endSelect(true);
    hideTooltip();
    for (const s of this.scopes.values()) {
      s.view.el.style.visibility = 'hidden';
      s.balloon.el.style.visibility = 'hidden';
    }
    this.ready = false;
    this.suspended = true;
    this.flushChangeNotice();
    await this.notify('OnCacheSuspend');
  }

  /** ゴーストキャッシュから戻る (OnCacheRestore の後、切り替え・呼び出しのあいさつ) */
  async resume(mode: BootMode): Promise<void> {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.closing = false;
    this.minimized = false;
    for (const s of this.scopes.values()) {
      s.view.el.style.visibility = '';
      s.balloon.el.style.visibility = '';
    }
    if (mode.kind === 'changed') {
      const refs: string[] = [mode.from.sakuraName, this.sakuraName, mode.script, '', mode.from.name, this.name];
      refs[14] = mode.fromShell;
      refs[15] = this.shell.name;
      this.changeNotice = refs;
    }
    this.secondTimer = window.setInterval(() => void this.onSecond(), 1000);
    this.ready = true;
    await this.notify('OnCacheRestore');
    this.state.bootCount = (this.state.bootCount ?? 0) + 1;
    this.state.lastBootAt = Date.now();
    saveSettings();
    void this.bootTalk(mode, false);
  }

  /**
   * 消滅。OnVanishSelected のスクリプトを再生して終了し、そのスクリプトを返す。
   * ほかのゴーストへの OnOtherGhostVanished は GhostManager が送る
   */
  async vanishOut(): Promise<string | undefined> {
    this.player.abort();
    // 消滅のスクリプトの途中でバルーンをダブルクリックされたら取りやめる (OnVanishButtonHold)
    this.vanishing = true;
    this.vanishHeld = false;
    const value = await this.request('GET', 'OnVanishSelected');
    if (value) await this.playScript(value, { event: 'OnVanishSelected' });
    this.vanishing = false;
    if (this.vanishHeld || this.destroyed) return undefined;
    this.closing = true;
    await this.destroy({ silent: true });
    return value ?? '';
  }

  private vanishing = false;
  private vanishHeld = false;

  /** インダクションモード */
  get inductionMode(): boolean {
    return this.modes.has('inductionmode');
  }

  /** 消滅の確認ダイアログの前後 (OnVanishSelecting・OnVanishCancel) */
  async vanishQuery(stage: 'selecting' | 'cancel'): Promise<void> {
    await this.raise(stage === 'selecting' ? 'OnVanishSelecting' : 'OnVanishCancel', [], { wait: true });
  }

  private async finishClose(): Promise<void> {
    await new Promise((r) => setTimeout(r, CLOSE_GRACE_MS));
    await this.destroy();
  }

  /**
   * @param opts.silent ほかのゴーストに OnOtherGhostClosed を送らない (切り替え・再起動)
   * @param opts.failedBoot 起動に失敗した後始末。起動していないので、ほかのゴーストには何も知らせない
   * @param opts.reload 読み直し (OnDestroy の Reference0 が reload)
   */
  async destroy(opts: { silent?: boolean; failedBoot?: boolean; reload?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    if (this.ready) await this.notify('OnDestroy', opts.reload ? ['reload'] : []).catch(() => undefined);
    this.destroyed = true;
    this.ready = false;
    this.player.abort();
    clearInterval(this.secondTimer);
    clearTimeout(this.balloonTimer);
    clearTimeout(this.restoreTimer);
    clearTimeout(this.linkHoverTimer);
    for (const t of this.namedTimers.values()) clearTimeout(t);
    this.namedTimers.clear();
    for (const m of this.moving) m.cancelled = true;
    this.afterScript = [];
    for (const s of this.sounds.values()) {
      s.audio.pause();
      if (s.revoke) URL.revokeObjectURL(s.url);
    }
    this.sounds.clear();
    for (const url of [...this.sockets.keys()]) this.closeWebSocket(url, 1000, true);
    this.endSelect(true);
    for (const a of this.httpAborts.values()) a.abort();
    window.speechSynthesis?.cancel();
    this.env.closeInput(this);
    this.env.setTrayIcon(this, undefined, '');
    this.state.totalSeconds = (this.state.totalSeconds ?? 0) + Math.floor((Date.now() - this.bootedAt) / 1000);
    saveSettings();
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
    hideTooltip();
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

  /** SHIORI の Status ヘッダ (ukadoc の currentghost.status) */
  status(): string {
    const s: string[] = [];
    if (this.player.playing) s.push('talking');
    if (this.modes.has('passivemode')) s.push('passive');
    if (this.modes.has('inductionmode')) s.push('induction');
    if (this.timeCritical) s.push('timecritical');
    if (this.modes.has('nouserbreakmode')) s.push('nouserbreak');
    if (this.modes.has('onlinemode')) s.push('online');
    if (this.choosing) s.push('choosing');
    if (this.minimized) s.push('minimizing');
    if (this.openInputs.length) s.push(`opening(${[...new Set(this.openInputs)].join('/')})`);
    const shown = [...this.scopes].filter(([, sc]) => sc.balloon.shown).map(([i, sc]) => `${i}=${sc.balloon.balloonId - (sc.balloon.balloonId % 2)}`);
    if (shown.length) s.push(`balloon(${shown.join('/')})`);
    return s.join(',');
  }

  async request(method: ShioriMethod, id: string, references: Reference[] = [], extra: Record<string, string> = {}, secret = false): Promise<string | undefined> {
    if (this.destroyed || !this.shiori || this.shioriUnloaded) return undefined;
    const headers: Record<string, string> = { ...extra };
    const status = this.status();
    if (status) headers.Status = status;
    try {
      const res = parseResponse(await this.shiori.request(buildRequest({ method, id, references, headers })));
      const refs = secret ? '(入力は記録しません)' : references.join(', ');
      this.env.log(this, 'request', `${method} ${id}${references.length ? ` [${refs}]` : ''}${res.value ? ` → ${res.value}` : ''}`);
      this.reportShioriErrors(id, res.headers);
      return res.value;
    } catch (e) {
      console.warn(`[${this.name}] ${id}:`, e);
      this.env.log(this, 'error', `${id}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 応答の ErrorLevel・ErrorDescription (SSP 拡張。複数は \x01 区切り) をエラーログに書く。同じものは1度だけ。
   * error・critical があれば、ゴーストごとに1度だけ通知する (SSP は通知領域のエラーアイコン)
   */
  private reportShioriErrors(id: string, headers: Map<string, string>): void {
    const levels = headers.get('errorlevel');
    if (!levels) return;
    const descriptions = (headers.get('errordescription') ?? '').split('\x01');
    levels.split('\x01').forEach((level, i) => {
      const text = `${level.trim()}: ${descriptions[i]?.trim() || '(説明なし)'}`;
      if (this.reportedErrors.has(text)) return;
      this.reportedErrors.add(text);
      this.env.log(this, 'error', `${id}: ${text}`);
      if (/^(error|critical)$/i.test(level.trim()) && !this.errorNotified) {
        this.errorNotified = true;
        this.env.toast(`「${this.name}」の SHIORI がエラーを知らせています (メニューの「ユーティリティ」→「エラーログ」で見られます)`);
      }
    });
  }

  notify(id: string, references: Reference[] = []): Promise<string | undefined> {
    return this.request('NOTIFY', id, references);
  }

  /** イベントを送り、返ってきたスクリプトを再生する。再生したスクリプトを返す。 */
  async raise(id: string, references: Reference[] = [], opts: RaiseOptions = {}): Promise<string | undefined> {
    if (this.leaving) return undefined;
    const value = await this.request(opts.method ?? 'GET', id, references, opts.headers, opts.secret);
    // NOTIFY の返事のスクリプトは再生しない (ukadoc: NOTIFY はゴーストに知らせるだけ)
    if (!value || this.leaving || opts.method === 'NOTIFY') return undefined;
    if (opts.ifIdle && this.busy) return undefined;
    const played = this.playScript(value, { event: id, refs: references, kinds: opts.kinds, noTranslate: opts.noTranslate });
    if (opts.wait) await played;
    return value;
  }

  /** トランスレート (OnTranslate)。返事が無ければそのまま */
  private async translate(script: string, ctx: ScriptContext): Promise<string> {
    if (ctx.noTranslate || ctx.event === 'OnTranslate') return script;
    const refs: Reference[] = [script, (ctx.kinds ?? []).join(',')];
    if (ctx.event) refs.push(ctx.event, (ctx.refs ?? []).join('\x01'));
    const value = await this.request('GET', 'OnTranslate', refs);
    return value || script;
  }

  /** ほかのゴーストに OnOtherGhostTalk を送る (\![set,otherghosttalk] で頼んだゴーストだけ) */
  private tellOthers(when: 'before' | 'after', script: string, ctx: ScriptContext, kinds: string[]): void {
    if (ctx.event === 'OnOtherGhostTalk') return;
    const refs = [this.name, this.sakuraName, kinds.join(','), ctx.event ?? '', script, (ctx.refs ?? []).join('\x01')];
    for (const g of this.env.others(this)) if (g.otherGhostTalk === when) void g.raise('OnOtherGhostTalk', refs);
  }

  async playScript(script: string, ctx: ScriptContext = {}): Promise<void> {
    if (this.destroyed) return;
    const translated = await this.translate(script, ctx);
    if (this.destroyed) return;
    this.context = ctx;
    this.broken = false;
    const kinds = [...(ctx.kinds ?? [])];
    if (ctx.noTranslate) kinds.push('notranslate');
    this.tellOthers('before', translated, ctx, kinds);
    this.env.log(this, 'script', translated);
    const sstp = this.scopes.get(0)?.balloon;
    if (ctx.sstpSender !== undefined) this.scope(0).balloon.setSstp(ctx.sstpSender);
    this.currentScript = translated;
    const r = await this.player.play(translated);
    if (ctx.sstpSender !== undefined) sstp?.setSstp(undefined);
    if (this.broken) kinds.push('break');
    if (!r.aborted || this.broken) this.tellOthers('after', translated, ctx, kinds);
    if (r.aborted || this.destroyed) return;
    this.lastScript = translated;
    this.endScript();
    if (r.exited) {
      if (!this.closing) {
        this.closing = true;
        await this.finishClose();
      }
      return;
    }
    this.runDeferred();
    if (!this.closing) this.armTimeouts(r, translated);
  }

  /** スクリプトの終わり。そのスクリプトの間だけのもの (\t・バルーンの再描画止め・口パク) を戻す */
  private endScript(): void {
    this.setTimeCritical(false);
    for (const s of this.scopes.values()) {
      if (!this.balloonRepaintManual) s.balloon.unlockRepaint();
      s.renderer.talkEnd();
    }
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
        void this.raise('OnBalloonTimeout', [script, 0], { ifIdle: true });
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
      .map(([title, url = '', thumbnail]) => ({ title, url, thumbnail }));
  }

  /** SHIORI のリソース (文字列)。メニューの名前など */
  async resource(id: string, refs: Reference[] = []): Promise<string | undefined> {
    return this.request('GET', id, refs);
  }

  /** AI グラフ (getaistateex、無ければ getaistate)。値・ラベル・加算値・最大値 */
  async aiState(): Promise<{ values: number[]; labels: string[]; adds: number[]; max: number[] }[]> {
    const parse = (v: string) => {
      const [values = '', labels = '', adds = '', max = ''] = v.split('\x01');
      const nums = (s: string) => s.split(',').filter(Boolean).map(Number);
      const vals = nums(values);
      return {
        values: vals,
        labels: labels ? labels.split(',') : ['Neuron', 'NeuronM', 'NeuronK', 'NeuronD', 'NeuronE', 'Synapse'].slice(0, vals.length),
        adds: nums(adds),
        max: nums(max),
      };
    };
    const out = [];
    for (let i = 0; i < 8; i++) {
      const v = await this.request('GET', 'getaistateex', [i]);
      if (!v) break;
      out.push(parse(v));
    }
    if (!out.length) {
      const v = await this.request('GET', 'getaistate');
      if (v) out.push(parse(v));
    }
    return out;
  }

  /** メニューでサイトが選ばれた。返事が無ければ開く */
  async chooseSite(site: Site, kind: 'recommend' | 'portal', scope: number, index: number): Promise<void> {
    const played = await this.raise('OnRecommendsiteChoice', [site.title, site.url, site.thumbnail ?? '', kind, scope, index]);
    if (!played) this.openUrl(site.url);
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
    balloon.setScale(settings.balloonScale ?? settings.scale);
    balloon.onClick = () => this.onBalloonClick();
    balloon.onDoubleClick = () => this.onBalloonDoubleClick(index);
    balloon.onMoved = () => this.saveBalloonOffset(index);
    balloon.dragLocked = this.balloonDontMove(index);
    const saved = this.state.balloonOffsets?.[index];
    if (saved) {
      balloon.userOffset.x = saved.x;
      balloon.userOffset.y = saved.y;
    }
    const view = new CharacterView(index, renderer, this.env.characters, {
      click: (e) => void this.onClick(e),
      doubleClick: (e) => void this.onMouse('OnMouseDoubleClick', e),
      move: (e) => this.onMouseMove(e),
      wheel: (e) => void this.onMouse('OnMouseWheel', e),
      enter: (e) => this.onEnter(e),
      leave: (e) => this.onLeave(e),
      contextMenu: (e) => {
        if (!this.passive) this.env.openMenu(this, e.clientX, e.clientY);
      },
      mouseDown: (e) => {
        this.applyCursor(e, 'mousedown');
        void this.onMouse('OnMouseDown', e, true);
      },
      mouseUp: (e, clicked) => void this.onMouseUp(e, clicked),
      dragStart: (e) => {
        if (!this.passive) void this.onMouse('OnMouseDragStart', e, true);
      },
      dragEnd: (e) => {
        if (!this.passive) void this.onMouse('OnMouseDragEnd', e, true);
      },
      hover: (e) => void this.onHover(e),
      moved: () => this.savePositions(),
      layout: () => this.layoutBalloon(index),
      dragged: (dx, dy) => this.dragSticky(index, dx, dy),
      pointerDown: () => this.env.focus(this),
      mouseDownEx: (e, name) => void this.onMouseEx('OnMouseDownEx', e, name),
      mouseUpEx: (e, name, clicked) => void this.onMouseUpEx(e, name, clicked),
      gesture: (e, start, direction) => {
        if (!this.ready || this.timeCritical) return;
        void this.raise('OnMouseGesture', [e.scope, `${e.x}\x01${e.y}`, e.collision, `${start.x}\x01${start.y}`, start.collision, direction], { ifIdle: direction !== 'end' });
      },
    });
    view.scale = settings.scale;
    const scaling = this.scalings.get(index);
    if (scaling) {
      view.scaleX = scaling.x;
      view.scaleY = scaling.y;
    }
    view.alignment = this.alignment(index);
    if (this.minimized) {
      view.el.style.visibility = 'hidden';
      balloon.el.style.visibility = 'hidden';
    }
    s = { renderer, view, balloon };
    this.scopes.set(index, s);
    this.applyZorder();
    return s;
  }

  /** descript の balloon.dontmove (ドラッグで動かせない) */
  private balloonDontMove(index: number): boolean {
    const v = this.setting(`${Shell.scopePrefix(index)}.balloon.dontmove`) || this.setting('balloon.dontmove');
    return v === '1' || v.toLowerCase() === 'true';
  }

  /** seriko.alignmenttodesktop (スコープごとの指定が優先) */
  private alignment(index: number, override?: string): Alignment {
    const v = (override ?? (this.setting(`${Shell.scopePrefix(index)}.seriko.alignmenttodesktop`) || this.setting('seriko.alignmenttodesktop'))).toLowerCase();
    return v === 'top' || v === 'left' || v === 'right' || v === 'free' ? v : 'bottom';
  }

  /** 毎フレーム (GhostManager の rAF から) */
  tick(now: number): void {
    for (const s of this.scopes.values()) s.renderer.tick(now);
  }

  /** 全体の拡大率が変わった・ウインドウの大きさが変わった */
  relayout(): void {
    for (const s of this.scopes.values()) {
      s.view.scale = settings.scale;
      s.balloon.setScale(settings.balloonScale ?? settings.scale);
      s.view.clamp();
      s.view.layout();
    }
  }

  /** オプションで倍率が変わった (OnShellScaling / OnBalloonScaling) */
  scalingChanged(shell: { before: number; after: number } | undefined, balloon: { before: number; after: number } | undefined): void {
    this.relayout();
    const pct = (v: number) => Math.round(v * 100);
    if (shell) void this.raise('OnShellScaling', [pct(shell.after), pct(shell.before), pct(shell.after), pct(shell.before)]);
    if (balloon) void this.raise('OnBalloonScaling', [pct(balloon.after), pct(balloon.before), pct(balloon.after), pct(balloon.before)]);
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
    if (this.placeDefault(index)) return;
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
    s.view.applyAlignment();
    s.view.layout();
  }

  /** SHIORI・descript の既定の位置に置く。指定が無ければ false */
  private placeDefault(index: number): boolean {
    const pos = this.defaultPositions.get(index);
    const s = this.scopes.get(index);
    if (!pos || !s) return false;
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    const r = s.view.rect();
    const base = this.basepos(index);
    const resolve = (v: number | undefined, size: number) => (v === undefined ? undefined : v < 0 ? size + Math.ceil(v) : v);
    const x = resolve(pos.x, dw);
    const y = resolve(pos.y, dh);
    let left = x !== undefined ? x - base.x : resolve(pos.left, dw - r.width);
    let top = y !== undefined ? y - base.y : resolve(pos.top, dh - r.height);
    if (left === undefined && top === undefined) return false;
    left ??= dw - 24 - r.width;
    top ??= dh - r.height;
    s.view.setTopLeft(left, top);
    return true;
  }

  /** 基準点 (point.basepos。無ければ中央下)。サーフェス座標に倍率を掛けたもの */
  private basepos(index: number): { x: number; y: number } {
    const s = this.scopes.get(index);
    if (!s) return { x: 0, y: 0 };
    const v = this.shell.surfaces.surfaces.get(s.renderer.surfaceId)?.values;
    const bx = v?.get('point.basepos.x') ?? this.shell.descript.num(`${Shell.scopePrefix(index)}.point.basepos.x`, NaN);
    const by = v?.get('point.basepos.y') ?? this.shell.descript.num(`${Shell.scopePrefix(index)}.point.basepos.y`, NaN);
    return {
      x: Number.isFinite(bx) ? bx * s.view.zoomX : s.view.width / 2,
      y: Number.isFinite(by) ? by * s.view.zoomY : s.view.height,
    };
  }

  /** 表示中のキャラクターのうち一番左の端 (デスクトップ座標) */
  leftEdge(): number {
    let left = this.env.desktop.clientWidth;
    for (const s of this.scopes.values()) if (s.renderer.visible && s.view.placed) left = Math.min(left, s.view.rect().left);
    return left;
  }

  /** 表示しているスコープ */
  visibleScopes(): number[] {
    return [...this.scopes].filter(([, s]) => s.renderer.visible && s.view.placed).map(([i]) => i);
  }

  /** 表示しているスコープを、手前 (Z 順の上) のものから */
  visibleScopesTopFirst(): number[] {
    const z = (i: number) => Number(this.scopes.get(i)?.view.el.style.zIndex) || 0;
    return this.visibleScopes().sort((a, b) => z(b) - z(a) || a - b);
  }

  /** キャラクターの矩形 (他のゴーストの \![move] の基準などに使う) */
  scopeRect(index: number): Rect | undefined {
    const s = this.scopes.get(index);
    return s?.renderer.visible ? s.view.rect() : undefined;
  }

  private savePositions(): void {
    const positions: Record<number, { right: number; bottom: number }> = {};
    for (const [i, s] of this.scopes) if (s.view.placed) positions[i] = { right: s.view.right, bottom: s.view.bottom };
    this.state.positions = positions;
    saveSettings();
    for (const i of this.scopes.keys()) this.layoutBalloon(i);
  }

  /** 位置を初めの状態に戻す (\![execute,resetwindowpos]・メニュー) */
  resetPositions(): void {
    delete this.state.positions;
    saveSettings();
    for (const s of this.scopes.values()) s.view.placed = false;
    for (const i of [...this.scopes.keys()].sort((a, b) => a - b)) this.place(i);
  }

  /** メニューの「位置のリセット」。OnResetWindowPos に返事が無ければ戻す */
  async requestResetPositions(): Promise<void> {
    const played = await this.raise('OnResetWindowPos');
    if (!played) this.resetPositions();
  }

  resetBalloonPositions(): void {
    delete this.state.balloonOffsets;
    saveSettings();
    for (const [i, s] of this.scopes) {
      s.balloon.resetUserOffset();
      this.layoutBalloon(i);
    }
  }

  private saveBalloonOffset(index: number): void {
    const b = this.scopes.get(index)?.balloon;
    if (!b) return;
    (this.state.balloonOffsets ??= {})[index] = { x: b.userOffset.x, y: b.userOffset.y };
    saveSettings();
  }

  /** sticky-window で同じグループのキャラクターを、ドラッグした量だけ動かす */
  private dragSticky(index: number, dx: number, dy: number): void {
    for (const other of this.stickyPartners(index)) {
      const s = this.scopes.get(other);
      if (!s) continue;
      const horizontal = s.view.alignment !== 'left' && s.view.alignment !== 'right';
      const vertical = s.view.alignment === 'free' || s.view.alignment === 'left' || s.view.alignment === 'right';
      if (horizontal) s.view.right -= dx;
      if (vertical) s.view.bottom = Math.max(0, s.view.bottom + dy);
      s.view.layout(true);
    }
  }

  private stickyPartners(index: number): number[] {
    const group = this.stickyGroups.find((g) => g.includes(String(index)));
    if (group) return group.map(Number).filter((i) => i !== index);
    // descript の seriko.sticky-window (例: 0,1)
    const fixed = this.setting('seriko.sticky-window');
    const ids = fixed.split(',').map((s) => s.trim()).filter(Boolean);
    return ids.includes(String(index)) ? ids.map(Number).filter((i) => i !== index) : [];
  }

  /** Z 順 (\![set,zorder] と常に手前)。グループの先頭ほど手前 */
  private applyZorder(): void {
    const groups = this.zorderGroups.length ? this.zorderGroups : parseGroups(this.setting('seriko.zorder'));
    const top = this.stayOnTop ? 100 : 0;
    for (const [i, s] of this.scopes) {
      let zs = 10;
      let zb = 50;
      for (const g of groups) {
        const n = g.length;
        g.forEach((item, rank) => {
          const kind = item[0] === 's' || item[0] === 'b' ? item[0] : '';
          const id = Number(kind ? item.slice(1) : item);
          if (id !== i) return;
          const z = n - rank;
          if (kind === 's') zs = 10 + z * 2;
          else if (kind === 'b') zb = 10 + z * 2;
          else {
            zs = 10 + z * 2;
            zb = 50 + z;
          }
        });
      }
      s.view.el.style.zIndex = String(zs + top);
      s.balloon.el.style.zIndex = String(zb + top);
    }
  }

  /**
   * バルーンを置く。\![set,balloonalign] が無ければ、sakura は左、それ以外は右を優先し (SSP と同じ)、
   * 画面に収まらないか、同じゴーストの他のキャラクターに被るときは反対側にする。
   */
  private layoutBalloon(index: number): void {
    const s = this.scopes.get(index);
    if (!s || !s.balloon.shown) return;
    const b = s.balloon;
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    const r = s.view.rect();
    const align = this.balloonAligns.get(index) ?? 'none';
    const offset = (axis: 'x' | 'y', suffix: string) => {
      const prefix = Shell.scopePrefix(index);
      const v = this.shell.surfaces.surfaces.get(s.renderer.surfaceId)?.values;
      const pick = (k: string) => v?.get(`${prefix}.balloon.offset${axis}${k}`) ?? v?.get(`balloon.offset${axis}${k}`) ?? this.shell.descript.num(`${prefix}.balloon.offset${axis}${k}`, NaN);
      let n = suffix ? pick(suffix) : NaN;
      if (!Number.isFinite(n)) n = pick('');
      if (!Number.isFinite(n)) n = 0;
      const set = this.balloonOffsets.get(index)?.[axis];
      if (set !== undefined && set !== '') n = set.startsWith('@') ? n + Number(set.slice(1)) : Number(set);
      return (Number(n) || 0) * settings.scale;
    };
    const place = (x: number, y: number) => b.moveTo(Math.min(Math.max(0, x), Math.max(0, dw - b.width)), Math.min(Math.max(0, y), Math.max(0, dh - b.height)));
    if (align === 'center' || align === 'top') {
      b.setSide(false);
      place(r.left + r.width / 2 - b.width / 2 + offset('x', 'c'), r.top - b.height + offset('y', ''));
      return;
    }
    if (align === 'bottom') {
      b.setSide(false);
      place(r.left + r.width / 2 - b.width / 2 + offset('x', 'b'), r.top + r.height + offset('y', ''));
      return;
    }
    const others = [...this.scopes]
      .filter(([i, o]) => i !== index && o.renderer.visible)
      .map(([, o]) => o.view.rect());
    const box = (right: boolean) => {
      b.setSide(right);
      const ox = offset('x', right ? 'r' : 'l');
      const oy = offset('y', '');
      const x = right ? r.left + r.width - ox : r.left - b.width + ox;
      const y = Math.min(Math.max(0, r.top + oy), Math.max(0, dh - b.height));
      return { right, x, y, w: b.width, h: b.height };
    };
    if (align === 'left' || align === 'right') {
      const c = box(align === 'right');
      place(c.x, c.y);
      return;
    }
    const fits = (c: ReturnType<typeof box>) => c.x >= 0 && c.x + c.w <= dw;
    const clear = (c: ReturnType<typeof box>) =>
      !others.some((o) => c.x < o.left + o.width && o.left < c.x + c.w && c.y < o.top + o.height && o.top < c.y + c.h);
    const preferRight = index !== 0;
    const candidates = [box(preferRight), box(!preferRight)];
    const pick = candidates.find((c) => fits(c) && clear(c)) ?? candidates.find(fits) ?? candidates[0];
    b.setSide(pick.right);
    place(pick.x, pick.y);
  }

  closeBalloons(): void {
    clearTimeout(this.balloonTimer);
    for (const s of this.scopes.values()) {
      s.balloon.hide();
      s.balloon.clear();
    }
  }

  /** 最小化 (隠す)。OnWindowStateMinimize */
  minimize(reason: 'user' | 'script' | 'system'): void {
    if (this.minimized || this.leaving) return;
    this.minimized = true;
    for (const s of this.scopes.values()) {
      s.view.el.style.visibility = 'hidden';
      s.balloon.el.style.visibility = 'hidden';
    }
    hideTooltip();
    void this.raise('OnWindowStateMinimize', [reason]);
  }

  /** 最小化から戻す。OnWindowStateRestore */
  restore(reason: 'user' | 'script' | 'system'): void {
    if (!this.minimized || this.leaving) return;
    this.minimized = false;
    for (const s of this.scopes.values()) {
      s.view.el.style.visibility = '';
      s.balloon.el.style.visibility = '';
    }
    void this.raise('OnWindowStateRestore', [reason]);
  }

  // ---------------------------------------------------------------- シェル・バルーン・着せ替え

  /**
   * シェルを切り替える。スクリプトから (\![change,shell]) のときは、--option=raise-event が無ければ
   * OnShellChanging を送らず、OnShellChanged はそのスクリプトが終わってから送る。
   */
  /**
   * \![reload,shell]: いまのシェルを、キャラクターのサーフェス・位置・Z 順をそのままに読み直す。
   * SHIORI がシェルのフォルダへ書いたもの (『CLDSP2+』のサーフェスの定義など) を先に書き戻してから読む
   */
  async reloadShell(): Promise<void> {
    await this.shiori?.flush?.();
    if (this.destroyed) return;
    await this.changeShell(this.shell.dir, { force: true });
  }

  async changeShell(dir: string, opts: { fromScript?: boolean; raiseEvent?: boolean; force?: boolean } = {}): Promise<void> {
    if (!this.shellDirs.includes(dir) || (dir === this.shell.dir && !opts.force)) return;
    const next = Shell.fromGhost(this.files, dir);
    const path = `shell/${dir}`;
    if (!opts.force && (!opts.fromScript || opts.raiseEvent)) {
      const value = await this.request('GET', 'OnShellChanging', [next.name, this.shell.name, path]);
      if (value) await this.playScript(value, { event: 'OnShellChanging' });
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
      s.view.alignment = this.alignment(i);
      s.balloon.dragLocked = this.balloonDontMove(i);
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
    this.applyZorder();
    saveSettings();
    if (opts.force) return;
    const changed = () => void this.raise('OnShellChanged', [next.name, this.name, path]);
    if (opts.fromScript) this.defer(changed);
    else changed();
  }

  async changeBalloon(key: string | null, opts: { fromScript?: boolean; force?: boolean } = {}): Promise<void> {
    this.skin = await this.env.loadBalloon(key);
    if (this.destroyed) return;
    this.state.balloon = key ?? undefined;
    if (key) addHistory('balloon', key);
    saveSettings();
    for (const [i, s] of this.scopes) {
      s.balloon.setSkin(this.skin);
      this.layoutBalloon(i);
    }
    if (opts.force) return;
    const changed = () => void this.raise('OnBalloonChange', [this.skin.name, key ?? '']);
    if (opts.fromScript) this.defer(changed);
    else changed();
  }

  bindGroups(scope: number) {
    return this.shell.bindGroups(scope).map((g) => ({ ...g, enabled: this.dressup.get(scope)?.has(g.id) ?? false }));
  }

  /** silent なら OnDressupChanged を送らない (\![bind-noevent]) */
  setDressup(scope: number, id: number, enabled?: boolean, fromScript = false, silent = false): void {
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
    if (silent) return;
    const changed = () => {
      void this.raise('OnDressupChanged', [scope, group.part, on ? 1 : 0, group.category, fromScript ? 'script' : 'user']).then(() => this.notifyDressup('GET'));
    };
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

  private mouseRefs(e: CharacterMouseEvent): Reference[] {
    return [e.x, e.y, e.wheel, e.scope, e.collision, e.button, e.device];
  }

  private async onMouse(id: string, e: CharacterMouseEvent, ifIdle = false): Promise<string | undefined> {
    if (!this.ready || this.timeCritical) return undefined;
    return this.raise(id, this.mouseRefs(e), { ifIdle });
  }

  /** 左ボタンを放した。OnMouseUp に返事が無ければクリック (3回目からは OnMouseMultipleClick) */
  private async onMouseUp(e: CharacterMouseEvent, clicked: boolean): Promise<void> {
    this.applyCursor(e, 'mouseup');
    const played = await this.onMouse('OnMouseUp', e, true);
    if (played || !clicked) return;
    if (e.clicks >= 3 && (await this.raise('OnMouseMultipleClick', [...this.mouseRefs(e), e.clicks]))) return;
    await this.onClick(e);
  }

  private async onClick(e: CharacterMouseEvent): Promise<void> {
    await this.onMouse('OnMouseClick', e);
  }

  /** 左・右以外のボタンのイベント (Reference5 がボタンの名前) */
  private onMouseEx(id: string, e: CharacterMouseEvent, name: string, extra: Reference[] = []): Promise<string | undefined> {
    if (!this.ready || this.timeCritical) return Promise.resolve(undefined);
    const refs = this.mouseRefs(e);
    refs[2] = 0;
    refs[5] = name;
    return this.raise(id, [...refs, ...extra]);
  }

  /** 左・右以外のボタンを放した。OnMouseUpEx に返事が無ければクリック (2回目はダブルクリック、3回目からは MultipleClickEx) */
  private async onMouseUpEx(e: CharacterMouseEvent, name: string, clicked: boolean): Promise<void> {
    if (await this.onMouseEx('OnMouseUpEx', e, name)) return;
    if (!clicked) return;
    if (e.clicks >= 3 && (await this.onMouseEx('OnMouseMultipleClickEx', e, name, [e.clicks]))) return;
    if (e.clicks === 2 && (await this.onMouseEx('OnMouseDoubleClickEx', e, name))) return;
    await this.onMouseEx('OnMouseClickEx', e, name);
  }

  /** キャラクターに入った (OnMouseEnterAll) */
  private onEnter(e: CharacterMouseEvent): void {
    const first = this.hovered.size === 0;
    this.hovered.set(e.scope, '');
    if (first) void this.onMouse('OnMouseEnterAll', e, true);
    this.onMouseMove(e);
  }

  /** キャラクターから出た (OnMouseLeave・OnMouseLeaveAll) */
  private onLeave(e: CharacterMouseEvent): void {
    const last = this.hovered.get(e.scope);
    if (last) void this.onMouse('OnMouseLeave', { ...e, collision: last }, true);
    this.hovered.delete(e.scope);
    if (this.hovered.size === 0) void this.onMouse('OnMouseLeaveAll', e, true);
    hideTooltip();
    document.documentElement.style.removeProperty('--engawa-cursor');
  }

  /** マウスの移動。当たり判定が変わったら OnMouseLeave / OnMouseEnter */
  private onMouseMove(e: CharacterMouseEvent): void {
    hideTooltip();
    this.applyCursor(e, 'mouseup');
    const last = this.hovered.get(e.scope) ?? '';
    if (last !== e.collision) {
      this.hovered.set(e.scope, e.collision);
      if (last) void this.onMouse('OnMouseLeave', { ...e, collision: last }, true);
      if (e.collision) void this.onMouse('OnMouseEnter', e, true);
    }
    void this.onMouse('OnMouseMove', e, true);
  }

  /** マウスが止まった。OnMouseHover とツールチップ (シェルの tooltips、無ければ SHIORI の tooltip) */
  private async onHover(e: CharacterMouseEvent): Promise<void> {
    this.applyCursor(e, 'mousehover');
    void this.onMouse('OnMouseHover', e, true);
    if (this.minimized) return;
    const text = this.shell.tooltip(e.scope, e.collision) ?? (await this.request('GET', 'tooltip', [e.x, e.y, 0, e.scope, e.collision, 0]));
    if (text && this.hovered.has(e.scope)) showTooltip(this.env.desktop, text, e.clientX, e.clientY);
  }

  /** マウスカーソル (シェルの cursor ブレス、\![set,property] の mousecursor) */
  private applyCursor(e: CharacterMouseEvent, state: string): void {
    const root = document.documentElement.style;
    const fileUrl = (p: string) => this.shellFileUrl(p) ?? this.blobUrl(p);
    let cursor = this.shell.cursor(e.scope, e.collision, state, fileUrl);
    const saved = this.state.properties ?? {};
    const own = e.collision ? (state === 'mousedown' ? saved['currentghost.mousecursor.grip'] : saved['currentghost.mousecursor']) : saved['currentghost.mousecursor.arrow'];
    if (own) {
      const url = fileUrl(own);
      if (url) cursor = `url(${url}), ${e.collision ? 'pointer' : 'default'}`;
    }
    if (!cursor) cursor = e.collision ? 'pointer' : 'default';
    root.setProperty('--engawa-cursor', cursor);
  }

  private onBalloonClick(): void {
    this.env.focus(this);
    if (this.player.waitingClick || this.player.playing) {
      this.player.skip();
      return;
    }
    if (this.choosing) return;
    this.closeBalloons();
    void this.raise('OnBalloonClose', [this.lastScript]).then((played) => {
      if (!played) this.armRestore();
    });
  }

  /** バルーンのダブルクリック。喋っている途中なら止める (OnBalloonBreak)。nouserbreakmode の間は止めない */
  /** バルーンのダブルクリック。喋っている途中なら止める (SSTP のスクリプトは OnSSTPBreak、消滅中は OnVanishButtonHold、ほかは OnBalloonBreak) */
  private onBalloonDoubleClick(scope: number): void {
    if (!this.player.playing || this.modes.has('nouserbreakmode')) return;
    const script = this.currentScript;
    const sstp = this.context.sstpSender !== undefined;
    this.broken = true;
    this.player.abort();
    this.endScript();
    if (this.vanishing) {
      this.vanishHeld = true;
      void this.raise('OnVanishButtonHold', [script, scope, 0]);
    } else void this.raise(sstp ? 'OnSSTPBreak' : 'OnBalloonBreak', [script, scope, 0]);
  }

  /** 再生中のスクリプト (OnBalloonBreak 用) */
  private currentScript = '';

  keyPress(key: string, code: number): void {
    if (!this.ready) return;
    void this.raise('OnKeyPress', [key, code]);
  }

  async communicate(text = ''): Promise<void> {
    const res = await this.openInput({ title: `「${this.sakuraName}」に話しかける`, kind: 'communicatebox', defaultText: text });
    if ('value' in res) await this.raise('OnCommunicate', ['user', res.value], { kinds: ['communicate'] });
    // ukadoc: 閉じられた場合は cancel (close / timeout は OnUserInputCancel の値)
    else await this.raise('OnCommunicateInputCancel', ['', 'cancel']);
  }

  /** TeachBox (\![open,teachbox]・\v)。OnTeachStart → OnTeach / OnTeachInputCancel */
  async teach(): Promise<void> {
    await this.raise('OnTeachStart', [], { wait: true });
    const res = await this.openInput({ title: `「${this.sakuraName}」に教える`, kind: 'teachbox' });
    if ('value' in res) {
      this.teachHistory.push(res.value);
      await this.raise('OnTeach', this.teachHistory);
    } else if (res.cancelled !== 'close' || !this.closedByScript) {
      await this.raise('OnTeachInputCancel', ['', res.cancelled]);
    }
    this.closedByScript = false;
  }

  /** \![close,teachbox] などで閉じた (キャンセルのイベントを送らない) */
  private closedByScript = false;

  private openInputKind(kind: InputKind): string {
    if (kind === 'communicatebox') return 'communicate';
    if (kind === 'teachbox') return 'teach';
    if (kind === 'textareabox') return 'textarea';
    return 'input';
  }

  private async openInput(req: InputRequest): Promise<InputResult> {
    const kind = this.openInputKind(req.kind);
    // 入力の候補 (SHIORI の inputbox.autocomplete。inputbox・teachbox・communicatebox だけ)
    if ((req.kind === 'inputbox' && req.type !== 'password') || req.kind === 'teachbox' || req.kind === 'communicatebox') {
      const list = await this.request('GET', 'inputbox.autocomplete', [req.kind, req.kind === 'inputbox' ? (req.id ?? '') : '']);
      if (list) req.suggestions = list.split('\x01').filter(Boolean);
    }
    this.openInputs.push(kind);
    try {
      return await this.env.input(this, req);
    } finally {
      this.openInputs.splice(this.openInputs.indexOf(kind), 1);
    }
  }

  private async onSecond(): Promise<void> {
    if (this.destroyed || this.secondBusy) return;
    this.elapsedSec++;
    for (const s of this.scopes.values()) s.renderer.secondTick(this.elapsedSec);
    this.secondBusy = true;
    try {
      this.checkOverlap();
      const idle = Math.floor((Date.now() - this.env.lastInputAt()) / 1000);
      // パッシブモード・最小化の間と喋っている間は、時間のイベントでは喋らない。
      // ukadoc: トーク再生不能な時は Reference3 を 0 にして NOTIFY で送り、返されたスクリプトは無視する
      const quiet = this.passive || this.minimized;
      const timeEvent = async (id: string) => {
        const canTalk = !quiet && !this.busy;
        const refs = [Math.floor((Date.now() - this.bootedAt) / 3_600_000), this.mikire() ? 1 : 0, this.kasanari() ? 1 : 0, canTalk ? 1 : 0, idle];
        await this.raise(id, refs, { ifIdle: true, method: canTalk ? 'GET' : 'NOTIFY' });
      };
      await timeEvent('OnSecondChange');
      // タイマーのずれで :00 を飛ばしても取りこぼさないよう、分が変わったかで判定する
      const now = new Date();
      if (now.getMinutes() !== this.lastMinute) {
        this.lastMinute = now.getMinutes();
        await timeEvent('OnMinuteChange');
      }
      // 時報: 喋れないときは喋れるようになるまで待つ
      if (now.getHours() !== this.lastHour && !this.busy && !quiet) {
        this.lastHour = now.getHours();
        await this.raise('OnHourTimeSignal', [Math.floor((Date.now() - this.bootedAt) / 3_600_000), this.mikire() ? 1 : 0, this.kasanari() ? 1 : 0, 1, idle]);
      }
    } finally {
      this.secondBusy = false;
    }
  }

  /** 重なり・見切れが変わったら OnOverlap / OnOffscreen */
  private checkOverlap(): void {
    const visible = [...this.scopes].filter(([, s]) => s.renderer.visible && s.view.placed);
    const pairs: string[] = [];
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i][1].view.rect();
        const b = visible[j][1].view.rect();
        if (a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height) pairs.push(`${visible[i][0]}-${visible[j][0]}`);
      }
    }
    const overlap = pairs.join('\x01');
    if (overlap !== this.lastOverlap) {
      void this.raise('OnOverlap', [overlap, this.lastOverlap], { ifIdle: true });
      this.lastOverlap = overlap;
    }
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    const off = visible
      .filter(([, s]) => {
        const r = s.view.rect();
        return r.left < 0 || r.top < 0 || r.left + r.width > dw || r.top + r.height > dh;
      })
      .map(([i]) => i)
      .join('\x01');
    if (off !== this.lastOffscreen) {
      void this.raise('OnOffscreen', [off, this.lastOffscreen], { ifIdle: true });
      this.lastOffscreen = off;
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

  /** ほかのゴーストのサーフェスが変わった (\![set,othersurfacechange,true] のときだけ) */
  otherSurfaceChanged(from: Ghost, scope: number, next: number, prev: number, rect: Rect): void {
    if (!this.otherSurfaceChange || !this.ready) return;
    void this.raise('OnOtherSurfaceChange', [from.name, from.sakuraName, scope, next, prev, [rect.left, rect.top, rect.left + rect.width, rect.top + rect.height].map(Math.round).join(',')], { ifIdle: true });
  }

  /** ファイル・URL・テキストのドロップ (キャラクターの上) */
  async dropFiles(scope: number, files: { name: string; type: string; data: Uint8Array }[]): Promise<boolean> {
    const paths: string[] = [];
    for (const f of files) {
      const name = f.name.replace(/[\\/:*?"<>|]/g, '_');
      this.saveFile(`ghost/master/drop/${name}`, f.data);
      // SSP と同じく区切りは \ (最後の \ の後ろをファイル名として取り出すゴーストがある)。Engawa もどの SHIORI も \ を区切りとして読む
      paths.push(`drop\\${name}`);
    }
    const refs = [paths.join('\x01'), scope, files.map((f) => f.type).join('\x01')];
    await this.notify('OnFileDropping', [paths.join('\x01'), scope]);
    for (const id of ['OnFileDrop2', 'OnFileDropEx', 'OnFileDrop', 'OnFileDropped']) {
      if (await this.raise(id, id === 'OnFileDrop' || id === 'OnFileDropped' ? [paths[0], scope, files[0]?.type ?? ''] : refs)) return true;
    }
    return this.dropDefault(scope, paths);
  }

  /**
   * ゴーストが答えなかったドロップの、本体の既定の処理 (\![execute,dropdefault,file] でも)。
   * 画像は画像ビューア、音・動画は鳴らす、アーカイブはアーカイブビューアで開き、それぞれ OnPictureViewerOpen などを送る
   */
  async dropDefault(scope: number, paths: string[]): Promise<boolean> {
    const files = paths.map((p) => p.trim()).filter(Boolean);
    const first = files[0];
    if (!first || !this.ghostFile(first)) return false;
    const type = mimeOf(first);
    const refs = [files.join('\x01'), scope, files.map(mimeOf).join('\x01')];
    if (type.startsWith('image/')) {
      this.env.openTool(this, 'pictureviewer', [first]);
      await this.raise('OnPictureViewerOpen', refs);
    } else if (type.startsWith('audio/') || type.startsWith('video/')) {
      this.playSound(first);
      await this.raise('OnMediaPlayerOpen', refs);
    } else if (/\.(zip|nar|lzh|7z|cab|rar)$/i.test(first)) {
      this.env.openTool(this, 'archiveviewer', [first]);
      await this.raise('OnArchiveViewerOpen', refs);
    } else return false;
    return true;
  }

  /** フォルダのドロップ (インストールできるものではないもの)。ghost/master/drop/ に写して OnDirectoryDrop */
  async dropDirectory(scope: number, name: string, files: FileTree): Promise<void> {
    const dir = `drop/${name.replace(/[\\/:*?"<>|]/g, '_')}`;
    for (const [p, data] of files.entries()) this.saveFile(`ghost/master/${dir}/${p}`, data);
    await this.raise('OnDirectoryDrop', [dir, scope]);
  }

  /** ファイルでも URL でも文字でもないもの (OnOtherObjectDropped) */
  async dropOther(scope: number, types: string[]): Promise<void> {
    await this.raise('OnOtherObjectDropped', [scope, types.join('\x01'), types.join('\x01')]);
  }

  /** URL のドロップ。OnURLQuery に返事があればそれで終わり、無ければ .nar としてインストールを試す */
  async dropUrl(scope: number, url: string): Promise<void> {
    if (await this.raise('OnURLQuery', [url, scope])) return;
    await this.raise('OnURLDropping', [url, scope], { wait: true });
    await this.env.installFrom(this, url);
  }

  async dropText(scope: number, text: string): Promise<void> {
    await this.raise('OnTextDrop', [text.replace(/\r\n|\r|\n/g, '\x01'), scope]);
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
    for (const s of this.scopes.values()) s.balloon.setOnline(this.modes.has('onlinemode'));
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
    const prev = s.renderer.surfaceId;
    const ok = await s.renderer.setSurface(id);
    if (!ok || this.destroyed) return;
    this.place(scope);
    s.view.layout();
    if (prev === s.renderer.surfaceId || !this.ready) return;
    // OnSurfaceChange (NOTIFY) と、頼まれていればほかのゴーストに OnOtherSurfaceChange
    const r = s.view.rect();
    void this.notify('OnSurfaceChange', [this.surfaceOf(0), this.surfaceOf(1), `${scope},${s.renderer.surfaceId},${Math.round(r.width)},${Math.round(r.height)}`]);
    for (const g of this.env.others(this)) g.otherSurfaceChanged(this, scope, s.renderer.surfaceId, prev, r);
  }

  playAnimation(scope: number, id: number): void {
    this.scope(scope).renderer.play(id);
  }

  waitAnimation(scope: number, id: number): Promise<void> {
    return this.scope(scope).renderer.waitAnimation(id);
  }

  talkChar(scope: number): void {
    const r = this.scopes.get(scope)?.renderer;
    r?.talkStart();
    r?.talk();
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
      case 'friendname':
        return this.descript.str('friend.name') || this.env.others(this)[0]?.sakuraName || '';
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
      case 'lastobjectname':
        return this.env.lastInstalled('ghost') ?? '';
      case 'songname':
        return [...this.sounds.values()].reverse().find((s) => !s.audio.paused)?.name ?? '';
    }
    if (name.startsWith('property:')) return this.property(name.slice(9));
    return randomWord(name) ?? '';
  }

  /** プロパティを読む (ukadoc のプロパティシステム) */
  property(path: string): string {
    return readProperty(path, this.propertyHost());
  }

  /** プロパティの読み書きに使う、いまの状態 */
  private propertyHost(): PropertyHost {
    const active: GhostListEntry[] = [this, ...this.env.others(this)].map((g) => ({ name: g.name, sakuraName: g.sakuraName, path: g.key, keroName: g.keroName, descript: g.descript }));
    const sounds: SoundInfo[] = [...this.sounds.values()].map((s) => ({
      name: s.name,
      playing: !s.audio.paused && !s.audio.ended,
      paused: s.audio.paused && s.audio.currentTime > 0 && !s.audio.ended,
      loop: s.audio.loop,
      volume: Math.round(s.audio.volume * 100),
      balance: s.balance ?? 0,
      duration: Number.isFinite(s.audio.duration) ? s.audio.duration : 0,
      position: s.audio.currentTime,
    }));
    const props = (this.state.properties ??= {});
    return {
      name: this.name,
      sakuraName: this.sakuraName,
      keroName: this.keroName,
      path: this.key,
      descript: this.descript,
      shell: this.shell,
      shellDirs: this.shellDirs,
      shellOf: (dir) => (dir === this.shell.dir ? this.shell : Shell.fromGhost(this.files, dir)),
      balloonName: this.skin.name,
      balloonPath: this.skin.key ?? '',
      balloonDescript: this.skin.descript,
      status: this.status(),
      userName: this.userName || settings.userName,
      desktop: { width: this.env.desktop.clientWidth, height: this.env.desktop.clientHeight },
      idleSeconds: Math.floor((Date.now() - this.env.lastInputAt()) / 1000),
      installed: this.env.installed(),
      active,
      scopes: [...this.scopes.keys()],
      scope: (id) => {
        const s = this.scopes.get(id);
        if (!s) return undefined;
        const rect = s.view.rect();
        const base = this.basepos(id);
        return {
          surface: s.renderer.surfaceId,
          animations: s.renderer.playingIds(),
          defaultSurface: this.defaultSurface(id),
          rect,
          base: { x: rect.left + base.x, y: rect.top + base.y },
          scaling: s.view.zoomX,
          name: '',
        };
      },
      balloon: (id) => {
        const s = this.scopes.get(id);
        if (!s) return undefined;
        const b = s.balloon;
        const r = b.el.getBoundingClientRect();
        const d = this.env.desktop.getBoundingClientRect();
        const text = this.skin.textRect(b.kind, b.balloonId, b.rightSide, b.width / b.scale, b.height / b.scale);
        const style = this.skin.style(b.kind, b.balloonId, b.rightSide);
        return {
          id: b.balloonId,
          count: this.skin.count(b.kind),
          rect: { left: r.left - d.left, top: r.top - d.top, width: b.width, height: b.height },
          valid: { width: (text.right - text.left) * b.scale, height: (text.bottom - text.top) * b.scale },
          basepos: { x: text.left, y: text.top },
          lineHeight: style.fontSize * 1.5 * b.scale,
          charWidth: (style.fontSize / 2) * b.scale,
          scaling: b.scale,
          vertical: b.vertical,
        };
      },
      sounds,
      sticky: this.stickyGroups.map((g) => g.join(',')).join(';'),
      zorder: this.zorderGroups.map((g) => g.join(',')).join(';'),
      saved: props,
      // ほかのゴーストのログ (SHIORI に送った値など) は見せない
      logs: (kind) => this.env.logs(kind).filter((l) => l.name === this.name),
      setSurface: (scope, id) => void this.setSurface(scope, id),
      playAnimation: (scope, id) => this.playAnimation(scope, id),
      setDefaultSurface: (scope, id) => this.defaultSurfaces.set(scope, id),
      setSticky: (text) => (this.stickyGroups = uniqueGroups(parseGroups(text))),
      setZorder: (text) => {
        this.zorderGroups = parseGroups(text);
        this.applyZorder();
      },
      setSound: (name, key, value) => this.soundOption(name, [`--${key}=${value}`]),
      save: () => saveSettings(),
    };
  }

  /** 選択肢・アンカーに重なった (OnChoiceEnter / OnAnchorEnter)、止まった (…Hover)、外れた (Reference なし) */
  hoverLink(kind: 'choice' | 'anchor', entering: boolean, title: string, id: string, refs: string[]): void {
    clearTimeout(this.linkHoverTimer);
    if (this.player.playing || !this.ready) return;
    const base = kind === 'choice' ? 'OnChoice' : 'OnAnchor';
    if (!entering) {
      void this.request('GET', `${base}Enter`).then((v) => v && void this.playScript(`\\C${v.replace(/^\\C/, '')}`, { event: `${base}Enter` }));
      return;
    }
    const r = [title, id, ...refs];
    void this.request('GET', `${base}Enter`, r).then((v) => v && void this.playScript(v.startsWith('\\C') ? v : `\\C${v}`, { event: `${base}Enter`, refs: r }));
    this.linkHoverTimer = window.setTimeout(async () => {
      const v = await this.request('GET', `${base}Hover`, r);
      if (v) void this.playScript(v.startsWith('\\C') ? v : `\\C${v}`, { event: `${base}Hover`, refs: r });
      // 選択肢のツールチップ (balloon_tooltip)
      if (kind === 'choice') {
        const tip = await this.request('GET', 'balloon_tooltip', r);
        const link = document.activeElement;
        if (tip && link instanceof HTMLElement) {
          const box = link.getBoundingClientRect();
          showTooltip(this.env.desktop, tip, box.left, box.bottom);
        }
      }
    }, 600);
  }

  /** 選択肢。再生中のスクリプトは止める (そうしないと残りの文字がバルーンを出し直す) */
  selectChoice(title: string, id: string, refs: string[]): void {
    clearTimeout(this.linkHoverTimer);
    hideTooltip();
    this.player.abort();
    this.endScript();
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
    clearTimeout(this.linkHoverTimer);
    if (/^On/.test(id)) {
      void this.raise(id, refs);
      return;
    }
    void (async () => {
      const played = (await this.raise('OnAnchorSelectEx', [title, id, ...refs])) ?? (await this.raise('OnAnchorSelect', [id, ...refs]));
      if (!played && /^(https?|mailto):/i.test(id)) this.openUrl(id);
    })();
  }

  /** \4 (離れる) / \5 (寄る)。相手は sakura なら kero、それ以外は sakura */
  async moveScope(scope: number, approach: boolean): Promise<void> {
    const me = this.scopes.get(scope);
    const other = this.scopes.get(scope === 0 ? 1 : 0);
    if (!me?.renderer.visible || !other?.renderer.visible) return;
    const a = me.view.rect();
    const b = other.view.rect();
    const leftOfOther = a.left + a.width / 2 < b.left + b.width / 2;
    let left: number;
    if (approach) left = leftOfOther ? b.left - a.width : b.left + b.width;
    else left = a.left + (leftOfOther ? -STEP_AWAY_PX : STEP_AWAY_PX);
    const dw = this.env.desktop.clientWidth;
    left = Math.min(Math.max(-a.width * 0.8, left), dw - a.width * 0.2);
    await me.view.animateTo(left, a.top, 300);
  }

  setTimeCritical(on: boolean): void {
    this.timeCritical = on;
  }

  /** \![embed]: イベントの結果をその場に差し込む */
  async embed(event: string, refs: string[]): Promise<string | undefined> {
    return this.request('GET', event, refs);
  }

  /** 喋った言葉の読み上げ (オプションで有効にしたときだけ) */
  speak(text: string): void {
    if (!settings.speech || typeof speechSynthesis === 'undefined' || this.minimized) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    speechSynthesis.speak(u);
  }

  async command(a: string[], scope: number): Promise<void> {
    const arg = a.map((s) => s.trim());
    const cmd = (arg[0] ?? '').toLowerCase();
    const sub = (arg[1] ?? '').toLowerCase();
    if (this.fromRemote && REMOTE_BLOCKED.test(`${cmd},${sub}`)) {
      this.env.log(this, 'error', `よそのページからの SSTP のスクリプトでは使えません: \\![${arg.slice(0, 2).join(',')}]`);
      return;
    }
    const raiseEvent = hasOption(arg, 'raise-event');
    switch (cmd) {
      case 'raise':
        if (arg[1]) void this.raise(arg[1], arg.slice(2));
        return;
      case 'notify':
        if (arg[1]) void this.notify(arg[1], arg.slice(2));
        return;
      case 'raiseother':
      case 'notifyother':
        // \![raiseother,ゴースト名,イベント名,r0…]。__SYSTEM_ALL_GHOST__ で全員。送れなかったら OnRaiseOtherFailure / OnNotifyOtherFailure
        if (arg[1] && arg[2]) {
          const failure = cmd === 'raiseother' ? 'OnRaiseOtherFailure' : 'OnNotifyOtherFailure';
          const targets = this.otherTargets(arg[1]);
          if (!targets.length) {
            void this.raise(failure, ['notfound', arg[1], arg[2]]);
            return;
          }
          const failed: [string, string][] = [];
          for (const g of targets) {
            const why = g.locked ? 'timecritical' : g.passive ? 'passivemode' : g.inductionMode ? 'inductionmode' : g.isMinimized ? 'minimized' : '';
            if (why) failed.push([why, g.name]);
            else void (cmd === 'raiseother' ? g.raise(arg[2], arg.slice(3)) : g.notify(arg[2], arg.slice(3)));
          }
          if (failed.length) void this.raise(failure, [failed.map((f) => f[0]).join('\x01'), failed.map((f) => f[1]).join('\x01'), arg[2]]);
        }
        return;
      case 'timerraise':
      case 'timernotify':
      case 'timerraiseother':
      case 'timernotifyother': {
        // \![timerraise,ms,繰り返し,イベント,r0…]。同じイベント名は上書きし、ms が 0 なら取り消す。
        // 繰り返しは 0 で毎回、1 以上で1回だけ。…other は3つ目がゴースト名
        const other = cmd.endsWith('other');
        const target = other ? arg[3] : undefined;
        const event = other ? arg[4] : arg[3];
        if (!event) return;
        const key = `${target ?? ''}\x01${event}`;
        const ms = Number(arg[1]) || 0;
        const repeat = Number(arg[2]) || 0;
        const refs = arg.slice(other ? 5 : 4);
        clearTimeout(this.namedTimers.get(key));
        this.namedTimers.delete(key);
        if (ms <= 0) return;
        const notify = cmd.startsWith('timernotify');
        const fire = () => {
          if (this.destroyed) return;
          if (repeat === 0) this.namedTimers.set(key, window.setTimeout(fire, ms));
          else this.namedTimers.delete(key);
          const targets: Ghost[] = target ? this.otherTargets(target) : [this];
          for (const g of targets) void (notify ? g.notify(event, refs) : g.raise(event, refs));
        };
        this.namedTimers.set(key, window.setTimeout(fire, ms));
        return;
      }
      case 'change':
        if (sub === 'ghost' && arg[2]) this.env.changeGhost(this, arg[2], raiseEvent);
        else if (sub === 'shell' && arg[2]) await this.changeShellByName(arg[2], raiseEvent);
        else if (sub === 'balloon' && arg[2]) await this.changeBalloonByName(arg[2]);
        return;
      case 'call':
        if (sub === 'ghost' && arg[2]) this.env.callGhost(this, arg[2], raiseEvent);
        return;
      case 'open':
        await this.open(sub, arg.slice(2));
        return;
      case 'close':
        if (sub === 'websocket') this.closeWebSocket(arg[2] ?? '', Number(arg[3]) || 1000, false);
        else this.closeCommand(sub, arg[2]);
        return;
      case 'send':
        // \![send,websocket,URL,data…] (CRLF でつなぐ) / \![send,websocket-binary,URL,base64]
        if (sub === 'websocket' || sub === 'websocket-binary') this.sendWebSocket(arg[2] ?? '', sub === 'websocket' ? arg.slice(3).join('\r\n') : base64Bytes(arg[3] ?? ''));
        return;
      case 'cancel':
        if (sub === 'websocket') this.closeWebSocket(arg[2] ?? '', 1000, true);
        else if (sub === 'http' || sub === 'ical' || sub === 'rss') this.httpAborts.get(arg[2] ?? '')?.abort();
        return;
      case 'set':
        await this.set(sub, arg.slice(2), scope);
        return;
      case 'reset':
        this.reset(sub, arg.slice(2));
        return;
      case 'lock':
      case 'unlock':
        this.lock(cmd === 'lock', sub, arg.slice(2));
        return;
      case 'enter':
      case 'leave':
        this.mode(cmd === 'enter', sub, arg.slice(2), scope);
        return;
      case 'bind':
      case 'bind-noevent': {
        // \![bind,カテゴリ,パーツ,1/0]。パーツが空ならカテゴリ全部、値が無ければ切り替え
        const groups = this.shell.bindGroups(scope).filter((g) => g.category === arg[1] && (g.part === arg[2] || !arg[2]));
        const value = arg[3] === undefined || arg[3] === '' ? undefined : arg[3] === '1' || arg[3].toLowerCase() === 'true';
        for (const g of groups) this.setDressup(scope, g.id, value, true, cmd === 'bind-noevent');
        return;
      }
      case 'anim':
        this.anim(sub, arg.slice(2), scope);
        return;
      case 'sound':
        this.sound(sub, arg.slice(2));
        return;
      case 'get':
        if (sub === 'property' && arg[2]) void this.raise(arg[2], arg.slice(3).map((p) => this.property(p)));
        return;
      case 'wait':
        if (sub === 'syncobject' && arg[2]) await this.waitSync(arg[2], arg.slice(3));
        return;
      case 'move':
      case 'moveasync': {
        if (sub === 'cancel') {
          for (const m of this.moving) m.cancelled = true;
          return;
        }
        const done = this.move(arg.slice(1), scope);
        if (cmd === 'move') await done;
        return;
      }
      case 'execute':
        await this.execute(sub, arg.slice(2), scope);
        return;
      case 'vanishbymyself':
        await this.env.vanish(this, { next: arg[1] && !arg[1].startsWith('--') ? arg[1] : undefined, query: hasOption(arg, 'query') });
        return;
      case 'updatebymyself':
        void this.env.update(this, { targets: ['ghost'], reason: 'script', ...updateOptions(arg) });
        return;
      case 'update':
        if (sub === 'platform') this.env.toast('Engawa はページを読み直すと最新の版になります');
        else if (sub) void this.env.update(this, { targets: sub === 'all' ? ['ghost', 'shell', 'balloon'] : sub.split('+'), reason: 'script', ...updateOptions(arg) });
        return;
      case 'updateother':
        void this.env.update(this, { targets: arg.slice(1).filter((x) => x && !x.startsWith('--option')), reason: 'script', ...updateOptions(arg) });
        return;
      case 'reload':
        await this.env.reload(this, sub || 'ghost');
        return;
      case 'reloadsurface':
        await this.env.reload(this, 'shell');
        return;
      case 'unload':
        if (sub === 'shiori') {
          await this.shiori?.unload();
          this.shioriUnloaded = true;
        }
        return;
      case 'load':
        if (sub === 'shiori' && this.shioriUnloaded) {
          this.shiori = await this.loadShiori();
          this.shioriUnloaded = false;
          await this.notify('OnInitialize', ['reload']);
        }
        return;
      case 'executesntp':
      case 'biff':
      case 'effect':
      case 'effect2':
      case 'filter':
      case 'create':
        // ブラウザでは行えない (時計合わせ・メール・プラグイン・ショートカット)
        return;
      default:
        console.debug(`[${this.name}] 未対応のコマンド \\![${arg.join(',')}]`);
    }
  }

  /** \![raiseother] の宛先。__SYSTEM_ALL_GHOST__ なら自分以外の全員 */
  private otherTargets(name: string): Ghost[] {
    const others = this.env.others(this);
    if (name === '__SYSTEM_ALL_GHOST__') return others;
    return others.filter((g) => g.name === name || g.sakuraName === name || g.key === name);
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
    if (name === 'random') {
      const all = this.env.installed().filter((p) => p.kind === 'balloon');
      const pick = all[Math.floor(Math.random() * all.length)];
      if (pick) await this.changeBalloon(pick.key, { fromScript: true });
      return;
    }
    const key = name === 'lastinstalled' ? this.env.lastInstalled('balloon') : undefined;
    const b = this.env.installed().find((p) => p.kind === 'balloon' && (p.name === key || p.name === name || p.key === name || p.dir === name.toLowerCase()));
    if (b) await this.changeBalloon(b.key, { fromScript: true });
  }

  // ---------------------------------------------------------------- \![open,…] / \![close,…]

  private async open(sub: string, args: string[]): Promise<void> {
    switch (sub) {
      case 'browser':
        if (args[0]) this.openUrl(args[0]);
        return;
      case 'mailer':
        if (args[0]) this.openUrl(`mailto:${args[0]}`);
        return;
      case 'file':
        if (args[0]) this.openUrl(args[0].includes(':') ? args[0] : `file:///${args[0]}`);
        return;
      case 'communicatebox':
        void this.communicate(optionValue(args, 'text') ?? (args[0] && !args[0].startsWith('--') ? args[0] : ''));
        return;
      case 'teachbox':
        void this.teach();
        return;
      case 'inputbox':
      case 'passwordinput':
      case 'textareabox':
      case 'dateinput':
      case 'timeinput':
      case 'sliderinput':
      case 'ipinput':
        void this.inputBox(sub, args);
        return;
      case 'dialog':
        void this.systemDialog((args[0] ?? '').toLowerCase(), args.slice(1));
        return;
      case 'readme':
      case 'terms':
      case 'help':
      case 'configurationdialog':
      case 'ghostexplorer':
      case 'shellexplorer':
      case 'balloonexplorer':
      case 'dressupexplorer':
      case 'pluginexplorer':
      case 'headlinesensorexplorer':
      case 'rateofusegraph':
      case 'rateofusegraphballoon':
      case 'rateofusegraphtotal':
      case 'developer':
      case 'surfacetest':
      case 'shiorirequest':
      case 'errorlog':
      case 'backlogviewer':
      case 'aigraph':
      case 'addressbar':
      case 'archiveviewer':
      case 'pictureviewer':
        this.env.openTool(this, sub, args);
        return;
      default:
        // editor・explorer・messenger・calendar などはブラウザでは開けない
        console.debug(`[${this.name}] \\![open,${sub}] はブラウザでは開けません`);
    }
  }

  private closeCommand(sub: string, id: string | undefined): void {
    switch (sub) {
      case 'inputbox':
        for (const kind of ['inputbox', 'dateinput', 'timeinput', 'sliderinput', 'ipinput'] as const) this.env.closeInput(this, { kind, id });
        return;
      case 'textareabox':
      case 'communicatebox':
        this.env.closeInput(this, { kind: sub, id });
        return;
      case 'teachbox':
        this.closedByScript = true;
        this.env.closeInput(this, { kind: 'teachbox' });
        return;
      case 'dialog':
        closeSystemDialogs(id);
        return;
    }
  }

  /**
   * 入力ボックス (\![open,inputbox,ID,表示時間,テキスト,オプション…] など)。ID が On で始まればそのイベント
   * (Reference0 = 入力) を、それ以外は OnUserInput (textareabox は OnTextAreaInput) を送る。
   * 閉じた・時間切れは OnUserInputCancel (Reference1 = close / timeout)
   */
  private async inputBox(kind: string, args: string[]): Promise<void> {
    const id = args[0] ?? '';
    const plain = args.slice(1).filter((x) => !x.startsWith('--'));
    const timeout = Number(optionValue(args, 'timeout') ?? plain[0]) || 0;
    const text = optionValue(args, 'text')?.replace(/^"|"$/g, '');
    const refs = args.filter((x) => x.toLowerCase().startsWith('--reference=')).map((x) => x.slice(12));
    const numbers = (n: number) => (text !== undefined ? text.split(',') : plain.slice(1, 1 + n)).map(Number).filter((v) => Number.isFinite(v));
    const types: Record<string, NonNullable<InputRequest['type']>> = { passwordinput: 'password', textareabox: 'textarea', dateinput: 'date', timeinput: 'time', sliderinput: 'slider', ipinput: 'ip' };
    const type = types[kind] ?? 'text';
    const values = type === 'date' || type === 'time' ? numbers(3) : type === 'ip' ? numbers(4) : type === 'slider' ? numbers(3) : undefined;
    const req: InputRequest = {
      title: this.sakuraName,
      kind: kind === 'passwordinput' ? 'inputbox' : (kind as InputKind),
      id,
      type,
      defaultText: (text ?? plain[1])?.replace(/\x01/g, '\n'),
      values: type === 'slider' ? values?.slice(0, 1) : values,
      min: type === 'slider' ? values?.[1] : undefined,
      max: type === 'slider' ? values?.[2] : undefined,
      placeholder: optionValue(args, 'placeholder')?.replace(/\x01/g, '\n'),
      limit: Number(optionValue(args, 'limit')) || undefined,
      timeout,
      noClose: args.some((x) => /^--option=+noclose$/i.test(x)),
    };
    const extra = type === 'slider' ? `${req.min ?? 0},${req.max ?? 100}` : '';
    const res = await this.openInput(req);
    if ('value' in res) {
      const secret = type === 'password';
      if (/^On/.test(id)) await this.raise(id, [res.value, extra, ...refs], { secret });
      else if (type === 'textarea') await this.raise('OnTextAreaInput', [id, res.value, '', ...refs]);
      else await this.raise('OnUserInput', [id, res.value, extra, ...refs], { secret });
      return;
    }
    if (type === 'textarea') {
      await this.raise('OnTextAreaInputCancel', [id, res.cancelled, '', ...refs]);
      return;
    }
    const played = await this.raise('OnUserInputCancel', [id, res.cancelled, extra, ...refs]);
    if (!played && res.cancelled === 'timeout') await this.raise('OnUserInput', [id, 'timeout', extra, ...refs]);
  }

  /**
   * \![open,dialog,open|save|folder|color,…]。選んだファイルはゴーストの ghost/master/upload/ に入れて、そのパスを返す。
   * save は download/ のパスを返し、ゴーストがそこへ書いたらダウンロードさせる
   */
  private async systemDialog(kind: string, args: string[]): Promise<void> {
    const id = optionValue(args, 'id') ?? '';
    const event = /^On/.test(id) ? id : 'OnSystemDialog';
    const cancel = /^On/.test(id) ? `${id}Cancel` : 'OnSystemDialogCancel';
    const result = await openSystemDialog(kind, args, id);
    if (result === undefined) {
      await this.raise(cancel, [kind, id]);
      return;
    }
    let value = result.value;
    if (kind === 'open' && result.files) {
      const paths: string[] = [];
      for (const f of result.files) {
        const path = `ghost/master/upload/${f.name.replace(/[\\/:*?"<>|]/g, '_')}`;
        this.saveFile(path, f.data);
        paths.push(path.slice('ghost/master/'.length));
      }
      value = paths.join('|');
    }
    // 名前を聞いて返したパスだけ、書かれたらダウンロードにする (ほかの download/ への書き込みは普通のファイル)
    if (kind === 'save' && value) this.saveTargets.add(normalizePath(`ghost/master/${value}`));
    await this.raise(event, [kind, id, value]);
  }

  // ---------------------------------------------------------------- \![set,…] / \![reset,…] / モード

  private async set(sub: string, args: string[], scope: number): Promise<void> {
    const s = () => this.scope(scope);
    switch (sub) {
      case 'balloontimeout':
      case 'choicetimeout': {
        // 省略で既定に戻す、0 以下でタイムアウトしない。そのスクリプトの間だけ有効
        const raw = args[0];
        let value: number | undefined;
        if (raw !== undefined && raw !== '') {
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          value = n <= 0 ? 0 : n;
        }
        if (sub === 'balloontimeout') this.balloonTimeout = value;
        else this.choiceTimeout = value;
        return;
      }
      case 'autoscroll':
        s().balloon.autoScroll = (args[0] ?? '').toLowerCase() !== 'disable';
        return;
      case 'balloonoffset':
        this.balloonOffsets.set(scope, { x: args[0] ?? '', y: args[1] ?? '' });
        this.layoutBalloon(scope);
        return;
      case 'balloonalign':
        this.balloonAligns.set(scope, (args[0] ?? 'none').toLowerCase());
        this.layoutBalloon(scope);
        return;
      case 'balloonmarker':
        s().balloon.setSstp(args[0] || undefined);
        return;
      case 'balloonnum':
        s().balloon.setNumber(args[0] ?? '', args[1] ?? '', args[2] ?? '');
        return;
      case 'scaling':
        await this.setScaling(scope, args);
        return;
      case 'alpha':
        await this.setAlpha(scope, args);
        return;
      case 'position': {
        // \![set,position,x,y,スコープ]: そこに固定する (ドラッグできない)
        const target = this.scope(args[2] !== undefined && args[2] !== '' ? Number(args[2]) : scope);
        target.view.setTopLeft(Number(args[0]) || 0, Number(args[1]) || 0);
        target.view.pinned = true;
        this.savePositions();
        return;
      }
      case 'zorder':
        if (args.length >= 2) {
          this.zorderGroups.push(args.map((x) => x.toLowerCase().replace(/^surface/, 's').replace(/^balloon/, 'b')));
          this.applyZorder();
        }
        return;
      case 'sticky-window':
        if (args.length >= 2 && !args.some((x) => this.stickyGroups.some((g) => g.includes(x)))) this.stickyGroups.push(args);
        return;
      case 'alignmenttodesktop':
      case 'alignmentondesktop': {
        const v = (args[0] ?? '').toLowerCase();
        const view = s().view;
        view.alignment = this.alignment(scope, v === 'default' ? undefined : v);
        view.applyAlignment();
        view.layout();
        return;
      }
      case 'windowstate': {
        const v = (args[0] ?? '').toLowerCase();
        if (v === 'stayontop' || v === '!stayontop') {
          this.stayOnTop = v === 'stayontop';
          this.applyZorder();
        } else if (v === 'minimize') this.defer(() => this.minimize('script'));
        return;
      }
      case 'property':
        if (args[0]) writeProperty(args[0], args.slice(1).join(','), this.propertyHost());
        return;
      case 'otherghosttalk': {
        const v = (args[0] ?? '').toLowerCase();
        this.otherGhostTalk = v === 'before' ? 'before' : v === 'true' || v === 'after' ? 'after' : 'false';
        return;
      }
      case 'othersurfacechange':
        this.otherSurfaceChange = boolArg(args[0]);
        return;
      case 'syncobject':
        if (args[0]) void this.env.sync(args[0], 'set');
        return;
      case 'tasktrayicon':
        this.env.setTrayIcon(this, args[0] ? this.blobUrl(args[0]) : undefined, args[1] ?? '');
        return;
      case 'trayballoon': {
        const text = args.filter((x) => x.toLowerCase().startsWith('--text=')).map((x) => x.slice(7)).join('\n');
        const title = optionValue(args, 'title') ?? '';
        const icon = optionValue(args, 'icon') ?? 'none';
        if (!text) return;
        void this.env.notify(this, title, text, icon).then((clicked) => this.raise(clicked ? 'OnTrayBalloonClick' : 'OnTrayBalloonTimeout', [title, text]));
        return;
      }
      case 'wallpaper':
      case 'shioridebugmode':
        return;
    }
  }

  private reset(sub: string, args: string[]): void {
    switch (sub) {
      case 'position':
        for (const s of this.scopes.values()) s.view.pinned = false;
        return;
      case 'zorder':
        this.zorderGroups = [];
        this.applyZorder();
        return;
      case 'sticky-window':
        this.stickyGroups = [];
        return;
      case 'syncobject':
        if (args[0]) void this.env.sync(args[0], 'reset');
        return;
    }
  }

  private lock(on: boolean, sub: string, args: string[]): void {
    switch (sub) {
      case 'repaint':
        for (const s of this.scopes.values()) s.renderer.setRepaintLocked(on);
        return;
      case 'balloonrepaint':
        this.balloonRepaintManual = on && (args[0] ?? '').toLowerCase() === 'manual';
        for (const s of this.scopes.values()) {
          if (on) s.balloon.lockRepaint();
          else s.balloon.unlockRepaint();
        }
        return;
      case 'balloonmove':
        for (const [i, s] of this.scopes) s.balloon.dragLocked = on || this.balloonDontMove(i);
        return;
    }
  }

  /** \![enter,…] / \![leave,…] */
  private mode(on: boolean, sub: string, args: string[], scope: number): void {
    const name = sub === 'selectrect' ? 'selectmode' : sub;
    if (on) this.modes.add(name);
    else this.modes.delete(name);
    if (name === 'onlinemode') {
      for (const s of this.scopes.values()) s.balloon.setOnline(on);
      if (on) this.showBalloon(0);
    } else if (name === 'collisionmode') {
      for (const s of this.scopes.values()) s.renderer.showCollisions(on ? ((args[0] ?? '').toLowerCase() === 'rect' ? 'rect' : 'name') : undefined);
    } else if (name === 'selectmode') {
      if (on) this.beginSelect(scope, args.slice(1));
      else this.endSelect();
    }
  }

  /** 矩形選択モード (\![enter,selectmode,rect,…])。キャラクターの上でドラッグして範囲を選ぶ */
  private selection?: { scope: number; el: HTMLElement; rect?: [number, number, number, number] };

  private beginSelect(scope: number, init: string[]): void {
    this.endSelect(true);
    const s = this.scopes.get(scope);
    if (!s?.renderer.visible) return;
    const r = s.view.rect();
    const el = document.createElement('div');
    el.className = 'select-overlay';
    Object.assign(el.style, { transform: `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`, width: `${r.width}px`, height: `${r.height}px` });
    const box = document.createElement('div');
    box.className = 'select-box';
    el.appendChild(box);
    this.env.desktop.appendChild(el);
    const sel: { scope: number; el: HTMLElement; rect?: [number, number, number, number] } = { scope, el };
    this.selection = sel;
    const zx = s.view.zoomX;
    const zy = s.view.zoomY;
    const show = () => {
      const q = sel.rect;
      box.hidden = !q;
      if (q) Object.assign(box.style, { left: `${q[0] * zx}px`, top: `${q[1] * zy}px`, width: `${(q[2] - q[0]) * zx}px`, height: `${(q[3] - q[1]) * zy}px` });
    };
    // 初めの範囲: 座標 (左,上,右,下) か、当たり判定の名前
    const nums = init.map(Number);
    if (init.length >= 4 && nums.slice(0, 4).every(Number.isFinite)) sel.rect = [nums[0], nums[1], nums[2], nums[3]];
    else if (init[0]) {
      const c = this.shell.surfaces.surfaces.get(s.renderer.surfaceId)?.collisions.find((x) => x.name === init[0]);
      if (c && c.coords.length >= 4) sel.rect = [c.coords[0], c.coords[1], c.coords[2], c.coords[3]];
    }
    show();
    const local = (e: PointerEvent) => {
      const b = el.getBoundingClientRect();
      return [Math.round((e.clientX - b.left) / zx), Math.round((e.clientY - b.top) / zy)] as const;
    };
    let from: readonly [number, number] | undefined;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      from = local(e);
      sel.rect = [from[0], from[1], from[0], from[1]];
      show();
      void this.raise('OnSelectModeMouseDown', [scope, 'rect', from.join(',')]);
    });
    el.addEventListener('pointermove', (e) => {
      if (!from) return;
      const p = local(e);
      sel.rect = [Math.min(from[0], p[0]), Math.min(from[1], p[1]), Math.max(from[0], p[0]), Math.max(from[1], p[1])];
      show();
    });
    el.addEventListener('pointerup', (e) => {
      if (!from) return;
      from = undefined;
      void this.raise('OnSelectModeMouseUp', [scope, 'rect', local(e).join(',')]);
    });
    void this.raise('OnSelectModeBegin', [scope, 'rect']);
  }

  /** 選択を終える。範囲があれば OnSelectModeComplete、無ければ OnSelectModeCancel (silent なら何も送らない) */
  private endSelect(silent = false): void {
    const sel = this.selection;
    if (!sel) return;
    this.selection = undefined;
    sel.el.remove();
    if (silent || this.destroyed) return;
    const q = sel.rect;
    if (q && q[2] > q[0] && q[3] > q[1]) void this.raise('OnSelectModeComplete', [sel.scope, 'rect', q.join(',')]);
    else void this.raise('OnSelectModeCancel', [sel.scope, 'rect']);
  }

  // ---------------------------------------------------------------- 見た目 (scaling・alpha・move・anim)

  /** --time=ms (位置の引数でもよい) と --wait */
  private timing(args: string[], at: number): { time: number; wait: boolean } {
    const plain = args[at] !== undefined && !args[at].startsWith('--') ? Number(args[at]) : NaN;
    const time = Math.max(0, Number(optionValue(args, 'time') ?? (Number.isFinite(plain) ? plain : 0)) || 0);
    return { time, wait: args.some((x) => x.toLowerCase() === '--wait') };
  }

  /** time ms かけて from から to へ (rAF)。step で値を当てる */
  private tween(time: number, step: (t: number) => void): Promise<void> {
    if (time <= 0) {
      step(1);
      return Promise.resolve();
    }
    const start = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!this.destroyed) step(1);
        resolve();
      };
      // 見えていないタブでは rAF が止まるので、時間が来たら終わりの値にする (スクリプトを止めたままにしない)
      const timer = window.setTimeout(finish, time + 100);
      const frame = (now: number) => {
        if (done) return;
        if (this.destroyed) return finish();
        const t = Math.min(1, (now - start) / time);
        if (t >= 1) return finish();
        step(t);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  /** \![set,scaling,倍率] / \![set,scaling,横,縦(,--time=,--wait)]。負の値は反転 */
  private async setScaling(scope: number, args: string[]): Promise<void> {
    const plain = args.filter((x) => !x.startsWith('--'));
    const x = Number(plain[0]);
    if (!Number.isFinite(x)) return;
    const y = plain[1] !== undefined && Number.isFinite(Number(plain[1])) ? Number(plain[1]) : x;
    const { time, wait } = this.timing(args, 2);
    const view = this.scope(scope).view;
    const from = { x: view.scaleX, y: view.scaleY };
    const to = { x: x / 100, y: y / 100 };
    this.scalings.set(scope, to);
    const run = this.tween(time, (t) => {
      view.scaleX = from.x + (to.x - from.x) * t;
      view.scaleY = from.y + (to.y - from.y) * t;
      view.layout();
    });
    if (wait) await run;
  }

  /** \![set,alpha,0〜100(,--time=,--wait)] */
  private async setAlpha(scope: number, args: string[]): Promise<void> {
    const v = Number(args[0]);
    const view = this.scope(scope).view;
    if (!Number.isFinite(v) || v < 0) {
      view.layout();
      return;
    }
    const to = Math.min(100, v) / 100;
    const from = view.el.style.opacity === '' ? 1 : Number(view.el.style.opacity);
    const { time, wait } = this.timing(args, 1);
    const run = this.tween(time, (t) => (view.el.style.opacity = String(from + (to - from) * t)));
    if (wait) await run;
  }

  /** \![move] / \![moveasync]。sticky-window の相手もいっしょに動かす */
  private async move(args: string[], scope: number): Promise<void> {
    const s = this.scopes.get(scope);
    if (!s?.renderer.visible) return;
    const req = parseMove(args);
    const me = s.view.rect();
    const dw = this.env.desktop.clientWidth;
    const dh = this.env.desktop.clientHeight;
    let base: Rect = { left: 0, top: 0, width: dw, height: dh };
    let baseBasepos: { x: number; y: number } | undefined;
    const b = req.base.toLowerCase();
    if (b === 'me') {
      base = me;
      baseBasepos = this.basepos(scope);
    } else if (/^\d+$/.test(b)) {
      const r = this.scopeRect(Number(b));
      if (!r) return;
      base = r;
      baseBasepos = this.basepos(Number(b));
    } else if (b.includes('/')) {
      const [who, id] = req.base.split('/');
      const g = [this, ...this.env.others(this)].find((x) => x.sakuraName === who || x.name === who);
      const r = g?.scopeRect(Number(id) || 0);
      if (!r) return;
      base = r;
    }
    const target = moveTarget(req, me, base, this.basepos(scope), baseBasepos);
    const signal = { cancelled: false };
    this.moving.add(signal);
    const dx = target.left - me.left;
    const dy = target.top - me.top;
    const partners = req.ignoreSticky ? [] : this.stickyPartners(scope);
    try {
      await Promise.all([
        s.view.animateTo(target.left, target.top, req.time, signal),
        ...partners.map((p) => {
          const o = this.scopes.get(p);
          if (!o?.renderer.visible) return Promise.resolve(true);
          const r = o.view.rect();
          return o.view.animateTo(r.left + dx, r.top + dy, req.time, signal);
        }),
      ]);
    } finally {
      this.moving.delete(signal);
    }
  }

  private anim(sub: string, args: string[], scope: number): void {
    const r = this.scope(scope).renderer;
    const id = () => r.animationId(args[0] ?? '') ?? Number(args[0]);
    switch (sub) {
      case 'start':
      case 'play':
        r.play(id());
        return;
      case 'stop':
      case 'clear':
        r.clear(id());
        return;
      case 'pause':
      case 'resume':
        r.pause(id(), sub === 'pause');
        return;
      case 'offset':
        r.offset(id(), Number(args[1]) || 0, Number(args[2]) || 0);
        return;
      case 'add': {
        // \![anim,add,overlay,ID(,x,y)] / overlayfast / base / move,x,y / text,x,y,幅,高さ,文字,表示時間,r,g,b,大きさ,字体
        const method = (args[0] ?? '').toLowerCase();
        if (method === 'move') r.add('move', -1, Number(args[1]) || 0, Number(args[2]) || 0);
        else if (method === 'text') {
          const [, x, y, w, h, text = '', time, cr, cg, cb, size, font] = args;
          const rgb = [cr, cg, cb].map((v) => Math.min(255, Math.max(0, Number(v) || 0)));
          r.addText({
            x: Number(x) || 0,
            y: Number(y) || 0,
            width: Number(w) || 0,
            height: Number(h) || 0,
            text: text.replace(/\\n/g, '\n'),
            time: Number(time) || 0,
            color: cr === undefined ? '#000' : `rgb(${rgb.join(',')})`,
            size: Number(size) || 12,
            font: font ? `"${font}", sans-serif` : 'sans-serif',
          });
        } else {
          const surface = this.shell.resolve(scope, args[1] ?? '');
          if (surface !== undefined) r.add(method, surface, Number(args[2]) || 0, Number(args[3]) || 0);
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------- \![execute,…]

  private async execute(sub: string, args: string[], scope: number): Promise<void> {
    const http = parseHttp(sub, args);
    if (http) {
      const done = this.runHttp(http);
      if (http.sync) await done;
      return;
    }
    switch (sub) {
      case 'resetwindowpos':
        this.resetPositions();
        return;
      case 'resetballoonpos':
        this.resetBalloonPositions();
        return;
      case 'install':
        if ((args[0] ?? '').toLowerCase() === 'url' && args[1]) await this.env.installFrom(this, args[1]);
        else if ((args[0] ?? '').toLowerCase() === 'path' && args[1]) await this.env.installFrom(this, args[1]);
        return;
      case 'dropdefault':
        if ((args[0] ?? '').toLowerCase() === 'url' && args[1]) await this.env.installFrom(this, args[1]);
        else if ((args[0] ?? '').toLowerCase() === 'file') await this.dropDefault(scope, args.slice(1).flatMap((a) => a.split(/\x01/)));
        return;
      case 'extractarchive':
        await this.archive('extract', args);
        return;
      case 'compressarchive':
        await this.archive('compress', args);
        return;
      case 'createnar':
        await this.createNar(args[0]);
        return;
      case 'createupdatedata':
        this.createUpdateData(args[0]);
        return;
      case 'dumpsurface':
        await this.dumpSurface(args, scope);
        return;
      case 'dumpballoon':
        await this.dumpBalloon(args, scope);
        return;
      case 'websocket':
        this.openWebSocket(args);
        return;
      case 'ical-get':
      case 'ical-post': {
        const done = this.runICal(sub === 'ical-post' ? 'post' : 'get', args);
        if (!optionValue(args, 'async')) await done;
        return;
      }
      case 'schedule-add':
      case 'schedule-delete':
      case 'schedule-get':
        await this.schedule(sub.slice(9), args);
        return;
      case 'headline':
      case 'calendarplugin':
      case 'ping':
      case 'nslookup':
      case 'filewatch':
      case 'emptyrecyclebin':
        // ブラウザでは行えない
        return;
    }
  }

  /** \![execute,http-…] / rss-…。結果は OnExecuteHTTPComplete などで返す */
  private async runHttp(req: HttpRequest): Promise<void> {
    this.modes.add('onlinemode');
    for (const s of this.scopes.values()) if (s.balloon.shown) s.balloon.setOnline(true);
    let res: Awaited<ReturnType<typeof runHttp>>;
    const ctrl = new AbortController();
    this.httpAborts.set(req.url, ctrl);
    // --progress-notify・--streaming: 届いた分を知らせる (Reference は Complete と同じ並び)
    const onChunk =
      req.progress || req.streaming
        ? (chunk: Uint8Array, received: number, total: number) => {
            if (req.streaming) void this.raise('OnExecuteHTTPStreaming', [req.method, req.id, req.url, '', new TextDecoder().decode(chunk).replace(/\r\n|\r|\n/g, '\x01'), '', '']);
            if (req.progress) void this.raise('OnExecuteHTTPProgress', [req.method, req.id, req.url, '', 'downloading', '', '', received, total]);
          }
        : undefined;
    try {
      res = await runHttp(req, ctrl.signal, onChunk);
    } finally {
      this.httpAborts.delete(req.url);
      this.modes.delete('onlinemode');
      for (const s of this.scopes.values()) s.balloon.setOnline(false);
    }
    if (this.destroyed) return;
    if (req.rss) {
      const items = res.ok && res.data ? parseFeed(res.data) : undefined;
      if (items) await this.raise(httpEvent(req, true), items);
      else await this.raise(httpEvent(req, false), [req.method, req.id, req.url, '', res.ok ? 'parse' : res.code, '', res.headers]);
      return;
    }
    let body = '';
    if (req.nofile !== undefined) body = nofileText(res.data, req.nofile);
    else if (res.data) {
      const path = `ghost/master/var/${httpFileName(req.file || new URL(req.url, location.href).pathname.split('/').pop() || '')}`;
      this.saveFile(path, res.data);
      body = path.slice('ghost/master/'.length);
    }
    await this.raise(httpEvent(req, res.ok), [req.method, req.id, req.url, body, res.code, '', res.headers]);
  }

  // ---------------------------------------------------------------- WebSocket・iCal・予定表

  private readonly sockets = new Map<string, { ws: WebSocket; id: string; opened: boolean; userClosed: boolean; retries: number; timer?: number }>();
  /** 進行中の HTTP・iCal (\![cancel,http,URL]) */
  private readonly httpAborts = new Map<string, AbortController>();

  /** --async=On… ならその名前 (+ 後ろに付けるもの)、無ければ既定の名前 */
  private eventName(id: string, base: string, suffix: string): string {
    return /^On/.test(id) ? `${id}${suffix}` : `${base}${suffix}`;
  }

  /** \![execute,websocket,URL,--async=ID]。切れたら5回までつなぎ直す */
  private openWebSocket(args: string[]): void {
    const url = args[0]?.trim();
    if (!url || this.sockets.has(url)) return;
    const id = optionValue(args, 'async') ?? optionValue(args, 'sync') ?? '';
    const base = 'OnExecuteWebSocket';
    const connect = () => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        void this.raise(this.eventName(id, base, 'Failure'), [id, url, (e as Error).message]);
        this.sockets.delete(url);
        return;
      }
      ws.binaryType = 'arraybuffer';
      const entry = this.sockets.get(url) ?? { ws, id, opened: false, userClosed: false, retries: 0 };
      entry.ws = ws;
      this.sockets.set(url, entry);
      ws.addEventListener('open', () => {
        const reconnect = entry.opened;
        entry.opened = true;
        entry.retries = 0;
        void this.raise(this.eventName(id, base, reconnect ? 'Reconnect' : 'Open'), [id, url, '200']);
      });
      ws.addEventListener('message', (e: MessageEvent) => {
        const text = typeof e.data === 'string';
        const data = text ? (e.data as string).replace(/\r\n|\r|\n/g, '\x01') : bytesBase64(new Uint8Array(e.data as ArrayBuffer));
        void this.raise(/^On/.test(id) ? id : `${base}Receive`, [id, url, text ? '1' : '2', data]);
      });
      ws.addEventListener('close', (e: CloseEvent) => {
        if (this.sockets.get(url)?.ws !== ws) return;
        if (entry.userClosed || e.code === 1000 || this.destroyed) {
          this.sockets.delete(url);
          if (!this.destroyed) void this.raise(this.eventName(id, base, 'Close'), [id, url, entry.userClosed && e.code !== 1000 ? 'userbreak' : String(e.code)]);
          return;
        }
        // 異常な切断: 最初の接続に失敗したか、5回つなぎ直しても駄目なら失敗
        if (!entry.opened || entry.retries >= 5) {
          this.sockets.delete(url);
          void this.raise(this.eventName(id, base, 'Failure'), [id, url, String(e.code || 'error')]);
          return;
        }
        entry.retries++;
        entry.timer = window.setTimeout(connect, 1000 * 2 ** (entry.retries - 1));
      });
    };
    connect();
  }

  private sendWebSocket(url: string, data: string | Uint8Array): void {
    const s = this.sockets.get(url);
    if (s?.ws.readyState === WebSocket.OPEN) s.ws.send(data as string | ArrayBufferView<ArrayBuffer>);
  }

  /** \![close,websocket,URL,code] / \![cancel,websocket,URL] (cancel は userbreak) */
  private closeWebSocket(url: string, code: number, cancel: boolean): void {
    const s = this.sockets.get(url);
    if (!s) return;
    s.userClosed = true;
    clearTimeout(s.timer);
    if (cancel) {
      this.sockets.delete(url);
      try {
        s.ws.close();
      } catch {
        // 閉じている
      }
      if (!this.destroyed) void this.raise(this.eventName(s.id, 'OnExecuteWebSocket', 'Close'), [s.id, url, 'userbreak']);
      return;
    }
    try {
      s.ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
    } catch {
      s.ws.close();
    }
  }

  /** \![execute,ical-get / ical-post,URL,…] (--from・--to・--expand・--limit で絞る) */
  private async runICal(method: 'get' | 'post', args: string[]): Promise<void> {
    const req = parseHttp(`http-${method}`, args);
    if (!req) return;
    const id = req.id;
    const fail = (code: string) => this.raise(this.eventName(id, 'OnExecuteICal', 'Failure'), [method, id, req.url, '', code]);
    const ctrl = new AbortController();
    this.httpAborts.set(req.url, ctrl);
    let res: Awaited<ReturnType<typeof runHttp>>;
    try {
      res = await runHttp(req, ctrl.signal);
    } finally {
      this.httpAborts.delete(req.url);
    }
    if (this.destroyed) return;
    if (!res.ok || !res.data) {
      await fail(res.code);
      return;
    }
    const cal = parseICal(new TextDecoder('utf-8').decode(res.data));
    if (!cal) {
      await fail('parse');
      return;
    }
    const filter = { from: optionValue(args, 'from'), to: optionValue(args, 'to'), expand: args.some((a) => /^--expand(=|$)/i.test(a.trim())) ? (optionValue(args, 'expand') ?? '') : undefined, limit: optionValue(args, 'limit') };
    await this.raise(/^On/.test(id) ? id : 'OnExecuteICalComplete', calendarRefs(cal, filter));
  }

  /** ゴースト用の予定表 (すべてのゴーストで共有。ページに保存する) */
  private async schedule(op: string, args: string[]): Promise<void> {
    const event = optionValue(args, 'event') ?? '';
    const ok = /^On/.test(event) ? event : op === 'get' ? 'OnExecuteScheduleGetComplete' : 'OnExecuteScheduleComplete';
    const ng = /^On/.test(event) ? `${event}Failure` : 'OnExecuteScheduleFailure';
    const list = (settings.schedule ??= []);
    if (op === 'get') {
      const filter = { from: optionValue(args, 'from'), to: optionValue(args, 'to'), expand: args.some((a) => /^--expand(=|$)/i.test(a.trim())) ? (optionValue(args, 'expand') ?? '') : undefined, limit: optionValue(args, 'limit') };
      await this.raise(ok, calendarRefs({ name: 'ghost', timezone: '', calscale: 'GREGORIAN', events: list }, filter));
      return;
    }
    // SSTP など外からのスクリプトでは予定を変えられない
    if (this.context.kinds?.some((k) => k === 'sstp-send' || k === 'remote')) {
      await this.raise(ng, [op, 'notauthorized', optionValue(args, 'uid') ?? args[0] ?? '']);
      return;
    }
    if (op === 'delete') {
      const uid = optionValue(args, 'uid') ?? args.find((a) => !a.startsWith('--')) ?? '';
      const i = list.findIndex((e) => e.uid === uid);
      if (!uid) await this.raise(ng, [op, 'invalid', '']);
      else if (i < 0) await this.raise(ng, [op, 'notfound', uid]);
      else {
        list.splice(i, 1);
        saveSettings();
        await this.raise(ok, [op, uid]);
      }
      return;
    }
    const summary = optionValue(args, 'summary');
    const start = parseScheduleDate(optionValue(args, 'start') ?? '');
    const endArg = optionValue(args, 'end');
    const end = endArg ? parseScheduleDate(endArg) : start;
    const uid = optionValue(args, 'uid') ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@engawa`;
    if (!summary || !start || !end || /\s/.test(uid)) {
      await this.raise(ng, [op, 'invalid', uid]);
      return;
    }
    const strip = (v: string | undefined) => (v ?? '').replace(/^"|"$/g, '');
    const ev: CalEvent = {
      uid,
      start,
      end,
      summary,
      description: optionValue(args, 'description') ?? '',
      location: optionValue(args, 'location') ?? '',
      url: optionValue(args, 'url') ?? '',
      status: (optionValue(args, 'status') ?? '').toUpperCase(),
      categories: strip(optionValue(args, 'categories')),
      rrule: strip(optionValue(args, 'rrule')),
      exdates: strip(optionValue(args, 'exdate'))
        .split(',')
        .map((d) => parseScheduleDate(d))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => String(Math.floor(Date.UTC(d.y, d.m - 1, d.d) / 86_400_000))),
    };
    const i = list.findIndex((e) => e.uid === uid);
    if (i >= 0) list[i] = ev;
    else list.push(ev);
    saveSettings();
    await this.raise(ok, [op, uid]);
  }

  /** ゴーストのフォルダの中のパス (ghost/master/ からの相対か、ゴーストのフォルダからの相対) */
  private ghostPath(p: string): string {
    const n = normalizePath(p.replace(/^[a-z]:\//i, '').replace(/^\/+/, ''));
    return this.files.has(n) || n.startsWith('ghost/') || n.startsWith('shell/') ? n : joinPath('ghost/master', n);
  }

  /** \![execute,extractarchive,ファイル,フォルダ] / compressarchive。ゴーストのフォルダの中だけ */
  private async archive(kind: 'extract' | 'compress', args: string[]): Promise<void> {
    const plain = args.filter((x) => !x.startsWith('--'));
    const event = optionValue(args, 'event');
    const base = kind === 'extract' ? 'OnExtractArchive' : 'OnCompressArchive';
    const ok = event && /^On/.test(event) ? event : `${base}Complete`;
    const ng = event && /^On/.test(event) ? `${event}Failure` : `${base}Failure`;
    const file = plain[0] ? this.ghostPath(plain[0]) : '';
    const dir = plain[1] ? this.ghostPath(plain[1]) : '';
    const run = async () => {
      try {
        if (kind === 'extract') {
          const data = this.files.get(file);
          if (!data) throw new Error('file not found');
          const tree = filesFromZip(data);
          let count = 0;
          let size = 0;
          for (const p of tree.list()) {
            const d = tree.get(p)!;
            this.saveFile(joinPath(dir, p), d);
            count++;
            size += d.length;
          }
          await this.raise(ok, [event ?? '', count, data.length, size]);
        } else {
          const entries: Record<string, Uint8Array> = {};
          let size = 0;
          const prefix = dir ? `${dir}/` : '';
          for (const p of this.files.list()) {
            if (!p.startsWith(prefix)) continue;
            const d = this.files.get(p)!;
            entries[p.slice(prefix.length)] = d;
            size += d.length;
          }
          const zip = zipSync(entries);
          this.saveFile(file, zip);
          await this.raise(ok, [event ?? '', Object.keys(entries).length, zip.length, size]);
        }
      } catch (e) {
        await this.raise(ng, [event ?? '', (e as Error).message]);
      }
    };
    if (event) void run();
    else await run();
  }

  /** \![execute,createnar]: ゴースト自身の .nar を作ってダウンロードさせる */
  private async createNar(out?: string): Promise<void> {
    const entries: Record<string, Uint8Array> = {};
    for (const p of this.files.list()) if (!p.startsWith('ghost/master/var/')) entries[p] = this.files.get(p)!;
    const name = out ? out.split(/[\\/]/).pop()! : `${this.meta.dir}.nar`;
    const path = out ? this.ghostPath(out) : `download/${name}`;
    await this.raise('OnNarCreating', [this.name, path, 'ghost'], { wait: true });
    const zip = zipSync(entries);
    if (out) this.saveFile(path, zip);
    download(name, zip);
    void this.raise('OnNarCreated', [this.name, path, 'ghost']);
  }

  /** \![execute,createupdatedata]: updates2.dau と updates.txt を作る */
  private createUpdateData(out?: string): void {
    void this.notify('OnUpdatedataCreating');
    this.writeUpdateData(out);
    void this.raise('OnUpdatedataCreated');
  }

  private writeUpdateData(out?: string): void {
    const lines = this.files
      .list()
      .filter((p) => !/^(updates2\.dau|updates\.txt)$/i.test(p) && !p.startsWith('ghost/master/var/') && !/(^|\/)(profile|ghost\/master\/drop|ghost\/master\/upload)\//.test(p))
      .sort()
      .map((p) => `${p}\x01${md5(this.files.get(p)!)}\x01size=${this.files.get(p)!.length}\x01`);
    const dau = new TextEncoder().encode(`${lines.join('\r\n')}\r\n`);
    const txt = new TextEncoder().encode(`charset,UTF-8\r\n${lines.map((l) => `file,${l}`).join('\r\n')}\r\n`);
    if (out) {
      const path = this.ghostPath(out);
      this.saveFile(path, path.toLowerCase().endsWith('.dau') ? dau : txt);
      return;
    }
    this.saveFile('updates2.dau', dau);
    this.saveFile('updates.txt', txt);
  }

  /** \![execute,dumpsurface,フォルダ,スコープ,サーフェス,prefix,イベント] */
  private async dumpSurface(args: string[], scope: number): Promise<void> {
    const plain = args.filter((x) => !x.startsWith('--'));
    const dir = optionValue(args, 'dir') ?? plain[0] ?? '';
    const sc = Number(optionValue(args, 'scope') ?? plain[1] ?? scope) || 0;
    const list = (optionValue(args, 'surface') ?? plain[2] ?? '__system_surface_all__').replace(/^"|"$/g, '');
    const prefix = optionValue(args, 'prefix') ?? plain[3] ?? 'surface';
    const event = optionValue(args, 'event') ?? optionValue(args, 'async') ?? plain[4];
    const ids = new Set<number>();
    if (list.startsWith('__system_surface_')) {
      readProperty(`currentghost.seriko.surfacelist.${list.includes('defined') ? 'defined' : 'all'}`, this.propertyHost())
        .split(',')
        .filter(Boolean)
        .forEach((v) => ids.add(Number(v)));
    } else {
      for (const part of list.split(',')) {
        const m = /^(\d+)-(\d+)$/.exec(part.trim());
        if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) ids.add(i);
        else if (part.trim()) ids.add(Number(part));
      }
    }
    const run = async () => {
      let count = 0;
      for (const id of ids) {
        const c = await this.shell.compose(id);
        if (!c) continue;
        const blob = await new Promise<Blob | null>((r) => c.canvas.toBlob(r, 'image/png'));
        if (!blob) continue;
        this.saveFile(joinPath(this.ghostPath(dir || 'dump'), `${prefix}${id}.png`), new Uint8Array(await blob.arrayBuffer()));
        count++;
      }
      void sc;
      if (event) await this.raise(event, [count]);
    };
    if (event) void run();
    else await run();
  }

  /** \![execute,dumpballoon,フォルダ,スコープ,prefix,イベント] (--dir= など、--hide=balloonmarker,balloonnum も) */
  private async dumpBalloon(args: string[], scope: number): Promise<void> {
    const plain = args.filter((x) => !x.startsWith('--'));
    const dir = optionValue(args, 'dir') ?? plain[0] ?? '';
    const sc = Number(optionValue(args, 'scope') ?? plain[1] ?? scope) || 0;
    const prefix = optionValue(args, 'prefix') ?? plain[2] ?? 'balloon';
    const event = optionValue(args, 'event') ?? optionValue(args, 'async') ?? plain[3];
    const hide = (optionValue(args, 'hide') ?? '').replace(/^"|"$/g, '').split(',').map((s) => s.trim().toLowerCase());
    const b = this.scopes.get(sc)?.balloon;
    let count = 0;
    const blob = b ? await b.snapshot(hide) : null;
    if (blob) {
      this.saveFile(joinPath(this.ghostPath(dir || 'dump'), `${prefix}${sc}.png`), new Uint8Array(await blob.arrayBuffer()));
      count = 1;
    }
    if (event) await this.raise(event, [count]);
  }

  // ---------------------------------------------------------------- 同期オブジェクト

  /** \![wait,syncobject,名前,タイムアウト]。スクリプトが止められたら待つのをやめる */
  private async waitSync(name: string, args: string[]): Promise<void> {
    const timeout = Number(optionValue(args, 'timeout') ?? args.find((x) => !x.startsWith('--'))) || 0;
    let timer: number | undefined;
    const aborted = new Promise<void>((resolve) => {
      timer = window.setInterval(() => {
        if (!this.player.playing || this.destroyed) resolve();
      }, 200);
    });
    try {
      await Promise.race([this.env.sync(name, 'wait', timeout), aborted]);
    } finally {
      clearInterval(timer);
    }
  }

  // ---------------------------------------------------------------- ファイル

  private ghostFile(path: string): { path: string; data: Uint8Array } | undefined {
    const p = path.replace(/^file:\/\/\/?/i, '');
    for (const c of [joinPath('ghost/master', p), normalizePath(p)]) {
      const data = this.files.get(c);
      if (data) return { path: c, data };
    }
    return undefined;
  }

  private blobUrl(path: string): string | undefined {
    const f = this.ghostFile(path);
    if (!f) return undefined;
    let url = this.blobUrls.get(f.path);
    if (!url) {
      url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: mimeOf(f.path) }));
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
      url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeOf(p) }));
      this.blobUrls.set(p, url);
    }
    return url;
  }

  /** ゴーストのフォルダの中のファイルの URL (readme・画像ビューアなど) */
  fileUrl(path: string): string | undefined {
    return this.blobUrl(path);
  }

  /** SHIORI (や SAORI) が書いたファイルを、表示に使う写しとセーブデータの両方に入れる */
  /** fromShiori は SHIORI じしんが書いたもの (SHIORI の側には既にある) */
  private saveFile(path: string, data: Uint8Array, fromShiori = false): void {
    const p = normalizePath(path);
    this.files.set(p, data);
    if (!fromShiori) this.shiori?.putFile?.(p, data);
    // 書き換えられた画像などは、作ってあった URL を作り直す
    for (const key of [p, ...[...this.blobUrls.keys()].filter((k) => k.startsWith(`${p}|`))]) {
      const url = this.blobUrls.get(key);
      if (url) {
        URL.revokeObjectURL(url);
        this.blobUrls.delete(key);
      }
    }
    // \![open,dialog,save] で返したパスへの書き込みは、ダウンロードにする (1回だけ。ゴーストが勝手にダウンロードさせられないように)
    if (this.saveTargets.delete(p)) download(p.slice('ghost/master/download/'.length), data);
    void writePackageFile(this.key, p, data).catch((e) => console.warn('[save]', e));
  }

  /** SAORI に頼まれたこと (Worker からは触れないもの) */
  private onSaori(effect: SaoriEffect): void {
    if (effect.kind === 'clipboard') {
      void copyText(effect.text);
    } else if (effect.kind === 'sound') {
      const data = effect.data ?? this.files.get(effect.path);
      if (data) this.startSound(effect.path, URL.createObjectURL(new Blob([data as BlobPart])), { revoke: true });
    } else if (effect.kind === 'write') {
      this.saveFile(effect.path, effect.data);
    } else if (effect.kind === 'event') {
      // SAORI over DirectSSTP の --async の結果
      void this.raise(effect.id, effect.refs);
    } else if (effect.kind === 'speak' && typeof speechSynthesis !== 'undefined') {
      if (effect.stop) speechSynthesis.cancel();
      else if (effect.text) {
        const u = new SpeechSynthesisUtterance(effect.text);
        u.lang = 'ja-JP';
        if (effect.rate) u.rate = Math.min(10, Math.max(0.1, effect.rate));
        speechSynthesis.speak(u);
      }
    }
  }

  // ---------------------------------------------------------------- 音

  playSound(file: string, loop = false): void {
    this.sound(loop ? 'loop' : 'play', [file]);
  }

  /** \![sound,play|loop|load|pause|resume|stop|option,ファイル,オプション…] */
  private sound(sub: string, args: string[]): void {
    const file = args[0] ?? '';
    const key = file.toLowerCase();
    const targets = () => (file ? [...this.sounds.values()].filter((s) => s.name.toLowerCase() === key) : [...this.sounds.values()]);
    switch (sub) {
      case 'play':
      case 'loop':
      case 'load': {
        if (!file) return;
        const url = /^https?:/i.test(file) ? file : this.blobUrl(file);
        if (!url) {
          void this.raise('OnSoundError', ['play', 0, file, 'file not found']);
          return;
        }
        this.startSound(file, url, { loop: sub === 'loop' || hasOption(args, 'loop'), load: sub === 'load', options: args.slice(1) });
        return;
      }
      case 'pause':
        targets().forEach((s) => s.audio.pause());
        if (file && args.length > 1) this.soundOption(file, args.slice(1));
        return;
      case 'resume':
        if (file && args.length > 1) this.soundOption(file, args.slice(1));
        targets().forEach((s) => void s.audio.play().catch(() => undefined));
        return;
      case 'stop':
        for (const s of targets()) this.stopSound(s, 'close');
        return;
      case 'option':
        this.soundOption(file, args.slice(1));
        return;
    }
  }

  /** --volume=0〜100 など。分からないものは無視 */
  private soundOption(file: string, options: string[]): boolean {
    const s = [...this.sounds.values()].reverse().find((x) => x.name.toLowerCase() === file.toLowerCase());
    if (!s) return false;
    const vol = optionValue(options, 'volume');
    if (vol !== undefined && Number.isFinite(Number(vol))) s.audio.volume = Math.min(1, Math.max(0, Number(vol) / 100));
    const seek = seekTime(optionValue(options, 'seektime') ?? optionValue(options, 'position'));
    if (seek !== undefined) s.audio.currentTime = seek / 1000;
    // --rate=1〜10000 (100 が通常の速さ)。ブラウザの再生できる速さは 0.0625〜16 倍
    const rate = Number(optionValue(options, 'rate'));
    if (Number.isFinite(rate) && rate > 0) s.audio.playbackRate = Math.min(16, Math.max(0.0625, rate / 100));
    const loop = optionValue(options, 'loop');
    if (loop !== undefined) s.audio.loop = boolArg(loop);
    const balance = optionValue(options, 'balance');
    if (balance !== undefined && Number.isFinite(Number(balance))) {
      s.balance = Number(balance);
      this.soundTap(s)?.setBalance(s.balance);
    }
    const spectrum = optionValue(options, 'spectrum');
    if (spectrum !== undefined) this.soundSpectrum(s, Number(spectrum) || 0, optionValue(options, 'spectrum-bands'), optionValue(options, 'spectrum-hold'));
    return true;
  }

  /** Web Audio に通す (ゴーストのファイルだけ。よそのサイトの音は CORS で無音になるので通さない) */
  private soundTap(s: Sound): AudioTap | undefined {
    if (!s.tap && s.url.startsWith('blob:')) s.tap = AudioTap.attach(s.audio);
    return s.tap;
  }

  /** --spectrum=間隔(ms): 鳴っている間 OnSoundSpectrum を送る。0 で止める (止めるときは0の知らせを1回) */
  private soundSpectrum(s: Sound, interval: number, bandsArg?: string, holdArg?: string): void {
    const zero = () => {
      const sp = s.spectrum;
      if (!sp) return;
      void this.raise('OnSoundSpectrum', [s.name, sp.bands, '0\x010', '0\x010', new Array(sp.bands).fill(0).join('\x01'), new Array(sp.bands).fill(0).join('\x01'), Math.round(s.audio.currentTime * 1000)], { ifIdle: true });
    };
    if (s.spectrum) {
      clearInterval(s.spectrum.timer);
      zero();
      s.spectrum = undefined;
    }
    if (interval <= 0) return;
    const tap = this.soundTap(s);
    if (!tap) return;
    const allowed = [0, 5, 10, 15, 31];
    const bands = allowed.includes(Number(bandsArg)) ? Number(bandsArg) : 10;
    const sp = { timer: 0, bands, peaks: [0, 0], bandPeaks: new Array(bands).fill(0), hold: Number(holdArg) || 1000, heldAt: performance.now() };
    sp.timer = window.setInterval(() => {
      if (this.destroyed || !this.sounds.has(s.name.toLowerCase())) {
        clearInterval(sp.timer);
        return;
      }
      if (s.audio.paused) return;
      const f = tap.measure(bands);
      const now = performance.now();
      // ピークは hold ms のあいだ保ち、過ぎたら今の値に戻す
      if (now - sp.heldAt > sp.hold) {
        sp.peaks = [...f.channels];
        sp.bandPeaks = [...f.bands];
        sp.heldAt = now;
      } else {
        sp.peaks = f.channels.map((v, i) => Math.max(v, sp.peaks[i] ?? 0));
        sp.bandPeaks = f.bands.map((v, i) => Math.max(v, sp.bandPeaks[i] ?? 0));
      }
      // 返したスクリプトは再生する (再生中の表示の更新に使うゴーストがある)。喋っている間は割り込まない
      void this.raise('OnSoundSpectrum', [s.name, bands, f.channels.join('\x01'), sp.peaks.join('\x01'), f.bands.join('\x01'), sp.bandPeaks.join('\x01'), Math.round(s.audio.currentTime * 1000)], { ifIdle: true });
    }, Math.max(16, interval));
    s.spectrum = sp;
  }

  /** 音を鳴らす。同じ名前の音は止めてから。終わったら OnSoundStop、失敗したら OnSoundError */
  private startSound(name: string, url: string, opts: { loop?: boolean; load?: boolean; revoke?: boolean; options?: string[] } = {}): void {
    const old = this.sounds.get(name.toLowerCase());
    if (old) this.stopSound(old, undefined);
    const audio = new Audio(url);
    audio.loop = !!opts.loop;
    const sound: Sound = { name, audio, url, revoke: !!opts.revoke };
    this.sounds.set(name.toLowerCase(), sound);
    if (opts.options) this.soundOption(name, opts.options);
    audio.addEventListener('ended', () => this.stopSound(sound, 'end'));
    // ループで頭に戻った (OnSoundLoop)
    let last = 0;
    audio.addEventListener('timeupdate', () => {
      if (audio.loop && audio.currentTime + 0.5 < last) void this.raise('OnSoundLoop', [name]);
      last = audio.currentTime;
    });
    audio.addEventListener('error', () => {
      this.forgetSound(sound);
      void this.raise('OnSoundError', ['play', audio.error?.code ?? 0, name, audio.error?.message ?? '']);
    });
    if (opts.load) {
      audio.preload = 'auto';
      return;
    }
    void audio.play().catch((e: Error) => {
      // 自動再生の制限で鳴らせなかった
      this.forgetSound(sound);
      void this.raise('OnSoundError', ['play', 0, name, e.message]);
    });
  }

  private forgetSound(s: Sound): void {
    if (this.sounds.get(s.name.toLowerCase()) === s) this.sounds.delete(s.name.toLowerCase());
    if (s.revoke) URL.revokeObjectURL(s.url);
  }

  /** reason があれば OnSoundStop を送る */
  private stopSound(s: Sound, reason: 'end' | 'close' | undefined): void {
    s.audio.pause();
    if (s.spectrum) this.soundSpectrum(s, 0);
    this.forgetSound(s);
    // 返したスクリプトは再生する (曲の終わりで次の曲を鳴らすプレイヤーのゴーストなど)
    if (reason) void this.raise('OnSoundStop', [s.name, reason]);
  }

  /** 再生中の (ループでない) 音が終わるまで。止められた・再生できなかった音は待たない */
  waitSound(): Promise<void> {
    const playing = [...this.sounds.values()].map((s) => s.audio).filter((s) => !s.paused && !s.ended && !s.error && !s.loop);
    return Promise.all(
      playing.map(
        (s) =>
          new Promise<void>((resolve) => {
            for (const ev of ['ended', 'error', 'pause', 'emptied']) s.addEventListener(ev, () => resolve(), { once: true });
          }),
      ),
    ).then(() => {});
  }

  // ---------------------------------------------------------------- 外へ

  /** \j・\![open,browser]。http・https・mailto はそのまま、file:/// とゴーストの中のパスはそのファイルを開く */
  openUrl(url: string): void {
    if (this.fromRemote) {
      this.env.log(this, 'error', `よそのページからの SSTP のスクリプトでは開けません: ${url}`);
      return;
    }
    if (/^(https?|mailto):/i.test(url)) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const local = this.pageUrl(url.replace(/^file:\/\/\/?/i, ''));
    if (local) window.open(local, '_blank', 'noopener');
  }

  /**
   * ゴーストのファイルを新しいタブで開くときの URL。blob: の URL はこのページと同じオリジンになるので、
   * スクリプトを動かせる種類 (HTML・SVG・XML など) はページとして開かず、テキストとして見せる
   */
  private pageUrl(path: string): string | undefined {
    const f = this.ghostFile(path);
    if (!f) return undefined;
    const type = mimeOf(f.path);
    if (/^(image\/(png|jpeg|gif|bmp|webp|x-icon)|audio\/|video\/|application\/pdf|text\/plain)/.test(type)) return this.blobUrl(path);
    const key = `${f.path}|text`;
    let url = this.blobUrls.get(key);
    if (!url) {
      url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'text/plain; charset=utf-8' }));
      this.blobUrls.set(key, url);
    }
    return url;
  }

  /** \_b の画像。伺かの透過規則 (左上の色・.pna) と --clipping を当ててから URL にする */
  async imageUrl(path: string, opts: InlineImageOptions): Promise<InlineImage | undefined> {
    const f = this.ghostFile(path);
    if (!f) return undefined;
    const key = `${f.path}|${opts.alpha}|${opts.clip?.join(' ') ?? ''}`;
    const cached = this.inlineImages.get(key);
    if (cached) return cached;
    try {
      const pna = opts.alpha === 'none' ? undefined : this.files.get(f.path.replace(/\.[^./]+$/, '') + '.pna');
      let canvas = await loadTransparentImage(f.data, pna, opts.alpha);
      if (opts.clip) {
        const [l, t, r, b] = opts.clip;
        const c = document.createElement('canvas');
        c.width = Math.max(1, r - l);
        c.height = Math.max(1, b - t);
        c.getContext('2d')?.drawImage(canvas, -l, -t);
        canvas = c;
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob || this.destroyed) return undefined;
      const url = URL.createObjectURL(blob);
      this.blobUrls.set(key, url);
      const img = { url, width: canvas.width, height: canvas.height };
      this.inlineImages.set(key, img);
      return img;
    } catch (e) {
      console.warn(`[${this.name}] \\_b ${path}:`, e);
      return undefined;
    }
  }

  private readonly inlineImages = new Map<string, InlineImage>();

  openCommunicate(): void {
    void this.communicate();
  }

  /** スクリプトの由来 (SSTP の送り主など) */
  get scriptContext(): ScriptContext {
    return this.context;
  }
}
