import type { FileTree } from '../vfs/files';
import type { Shiori, ShioriHooks } from './shiori';
import ShioriWorker from './shiori-worker.ts?worker&inline';
import type { FromWorker, ToWorker } from './worker-protocol';

const REQUEST_TIMEOUT_MS = 10_000;
const UNLOAD_TIMEOUT_MS = 3_000;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type Pending = { resolve(v: string | undefined): void; reject(e: Error): void; timer: number };

/**
 * JavaScript で書かれた SHIORI。ghost/master/<shiori> を ES モジュールとして Web Worker 内で読み込む。
 * モジュールは `load(dir)`, `request(text)`, `unload()` を export する (request は Promise でもよい)。
 */
export class JsShiori implements Shiori {
  private worker?: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly files: FileTree,
    readonly name: string,
    private readonly hooks: ShioriHooks,
  ) {}

  async load(): Promise<void> {
    // Worker は Blob として埋め込む (file:// で開いた index.html からでも起動できるように)
    this.worker = new ShioriWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.hooks.onLog(`SHIORI worker error: ${e.message}`);
    const master = this.files.sub('ghost/master');
    try {
      await this.call(
        { type: 'load', files: [...master.entries()], entry: this.name, dir: 'ghost/master/' },
        REQUEST_TIMEOUT_MS * 3,
      );
    } catch (e) {
      // 読み込みに失敗した Worker は残さない (ファイルの写しを持ったまま、ループしていることもある)
      this.terminate('SHIORI load failed');
      throw e;
    }
  }

  async request(text: string): Promise<string> {
    return (await this.call({ type: 'request', text }, REQUEST_TIMEOUT_MS)) ?? '';
  }

  async unload(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.call({ type: 'unload' }, UNLOAD_TIMEOUT_MS);
    } catch (e) {
      this.hooks.onLog(`SHIORI unload: ${(e as Error).message}`);
    } finally {
      this.terminate('SHIORI unloaded');
    }
  }

  private terminate(reason: string): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private call(msg: WithoutId<ToWorker>, timeout: number): Promise<string | undefined> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('SHIORI is not loaded'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SHIORI ${msg.type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...msg, id } as ToWorker);
    });
  }

  private onMessage(msg: FromWorker): void {
    if (msg.type === 'write') {
      this.hooks.onWrite(`ghost/master/${msg.path}`, msg.data);
      return;
    }
    if (msg.type === 'log') {
      this.hooks.onLog(msg.message);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error));
  }
}
