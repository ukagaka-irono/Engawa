import { Descript } from '../package/descript';
import type { SaoriEffect } from '../saori/context';
import { createShiori } from '../shiori/shiori';
import type { Shiori } from '../shiori/shiori';
import { UnsupportedShiori } from '../shiori/unsupported-shiori';
import { containsText } from '../util/bytes';
import { FileTree, normalizePath } from '../vfs/files';
import type { PackageMeta } from '../vfs/storage';
import { buildPluginRequest, parsePluginResponse, type PluginRequest, type PluginResponse } from './protocol';

export interface PluginHooks {
  /** プラグインがファイルを書いた (パスはプラグインのフォルダからの相対) */
  onWrite(path: string, data: Uint8Array): void;
  onLog(message: string): void;
  onSaori(effect: SaoriEffect): void;
}

/**
 * インストールしたプラグイン1つ (descript.txt と DLL)。
 * DLL は SHIORI と同じ load / request / unload なので、SHIORI と同じ仕組みで動かす
 * (YAYA・里々・華和梨などを PLUGIN として使うもの、JavaScript で書いたもの)。
 * プラグインのフォルダを、SHIORI でいう ghost/master として渡す
 */
export class Plugin {
  readonly name: string;
  readonly id: string;
  readonly filename: string;
  /** OnSecondChange を送る間隔 (秒)。0 なら送らない */
  readonly secondInterval: number;
  /** OnOtherGhostTalk を送るか (before・after) */
  readonly otherGhostTalk: 'false' | 'before' | 'after';
  readonly descript: Descript;
  /** version の答え */
  version = '';
  /** 読み込めて、要求を送れる */
  runnable = false;
  /** 読み込めなかった理由 */
  failed?: string;
  private shiori?: Shiori;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly meta: PackageMeta,
    readonly files: FileTree,
    private readonly hooks: PluginHooks,
  ) {
    this.descript = Descript.read(files, 'descript.txt');
    this.name = this.descript.str('name', meta.name);
    this.id = this.descript.str('id', meta.key);
    this.filename = this.descript.str('filename');
    const interval = this.descript.num('secondchangeinterval', 1);
    this.secondInterval = interval > 0 ? interval : 0;
    const talk = this.descript.str('otherghosttalk', 'false').toLowerCase();
    this.otherGhostTalk = talk === 'before' ? 'before' : talk === 'true' || talk === '1' || talk === 'after' ? 'after' : 'false';
  }

  get key(): string {
    return this.meta.key;
  }

  /** 読み込み、version を聞く。動かせなければ理由を返す */
  async load(): Promise<string | undefined> {
    if (!this.filename) return (this.failed = 'descript.txt に filename がありません');
    // プラグインのフォルダを ghost/master に置いた形にして、SHIORI と同じく動かす
    const tree = new FileTree([...this.files.entries()].map(([p, d]) => [`ghost/master/${p}`, d] as [string, Uint8Array]));
    const shiori = createShiori(tree, Descript.parse(`shiori,${normalizePath(this.filename)}`), {
      onWrite: (path, data) => {
        const rel = path.replace(/^ghost\/master\//, '');
        this.files.set(rel, data);
        this.hooks.onWrite(rel, data);
      },
      onLog: (m) => this.hooks.onLog(m),
      onSaori: (effect) => this.hooks.onSaori(effect),
    });
    if (shiori instanceof UnsupportedShiori) {
      // PLUGIN/1.0 (getversion・notify・configure を持つ、何か・SSP の昔のもの。FreeMem など) は、どれも Windows の DLL のまま
      const dll = this.files.get(normalizePath(this.filename));
      const v1 = dll && containsText(dll, 'PLUGIN/1.0') && !containsText(dll, 'request');
      return (this.failed = v1 ? `${this.filename} は PLUGIN/1.0 の Windows の DLL なので動かせません` : `${this.filename} は Engawa で動かせる形式ではありません`);
    }
    try {
      await shiori.load();
    } catch (e) {
      return (this.failed = `読み込みに失敗しました: ${(e as Error).message}`);
    }
    this.shiori = shiori;
    this.runnable = true;
    // version には Value で版を答える (Charset を付ければ、以後の要求の文字コードになる)
    const res = await this.request({ method: 'GET', id: 'version' });
    this.version = res?.value ?? '';
    return undefined;
  }

  /** 要求を1つずつ順に送る (プラグインの DLL は同時に呼ばれることを想定していない) */
  request(req: PluginRequest): Promise<PluginResponse | undefined> {
    const run = async (): Promise<PluginResponse | undefined> => {
      if (!this.shiori) return undefined;
      try {
        return parsePluginResponse(await this.shiori.request(buildPluginRequest(req)));
      } catch (e) {
        this.hooks.onLog(`${req.id}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async unload(): Promise<void> {
    const s = this.shiori;
    this.shiori = undefined;
    this.runnable = false;
    await s?.unload().catch((e) => this.hooks.onLog(`unload: ${(e as Error).message}`));
  }
}
