import type { SaoriEffect } from '../saori/context';
import type { ShioriHooks } from './shiori';

export const REQUEST_TIMEOUT_MS = 10_000;
export const UNLOAD_TIMEOUT_MS = 3_000;
/** Worker から送られる SSTP の要求の長さの上限 (SSP の Direct SSTP と同じく 1MB) */
const MAX_SSTP_LENGTH = 1024 * 1024;

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: number };

/** Worker への要求 (id は WorkerShiori が付ける) */
export interface WorkerCall {
  type: string;
}

/** Worker からの知らせ。result は要求への答え、write はセーブデータ、log はコンソールへ、saori は SAORI に頼まれたこと */
export type WorkerReply =
  | { id: number; type: 'result'; ok: true; value?: unknown }
  | { id: number; type: 'result'; ok: false; error: string }
  | { type: 'write'; path: string; data: Uint8Array }
  | { type: 'log'; message: string }
  | { type: 'saori'; effect: SaoriEffect }
  | { type: 'sstp'; id: number; request: string };

/**
 * Web Worker の中で動く SHIORI の共通部分 (JS 製・DLL を WebAssembly にしたもの)。
 * 要求ごとに id を付けて答えを待ち、時間切れや Worker の終了で待っている要求を失敗させる。
 */
export abstract class WorkerShiori {
  private worker?: Worker;
  private seq = 0;
  /** Worker からの SSTP を受けるか (SHIOLINK の Node.js のプログラムだけ) */
  protected acceptsSstp = false;
  private readonly pending = new Map<number, Pending>();

  constructor(protected readonly hooks: ShioriHooks) {}

  /** Worker を起動して最初の要求 (load) を送る。失敗したら Worker を残さない */
  protected async start(worker: Worker, load: WorkerCall, transfer: Transferable[] = []): Promise<void> {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onMessage(e.data);
    worker.onerror = (e) => this.hooks.onLog(`SHIORI worker error: ${e.message}`);
    try {
      await this.call(load, REQUEST_TIMEOUT_MS * 3, transfer);
    } catch (e) {
      // 読み込みに失敗した Worker は残さない (ファイルの写しを持ったまま、ループしていることもある)
      this.terminate('SHIORI load failed');
      throw e;
    }
  }

  protected async stop(unload: WorkerCall): Promise<void> {
    if (!this.worker) return;
    try {
      await this.call(unload, UNLOAD_TIMEOUT_MS);
    } catch (e) {
      this.hooks.onLog(`SHIORI unload: ${(e as Error).message}`);
    } finally {
      this.terminate('SHIORI unloaded');
    }
  }

  /** Worker の中のファイルの写しにも置く (要求の順に届くので、次の request からは読める) */
  putFile(path: string, data: Uint8Array): void {
    if (!this.worker || !path.startsWith('ghost/master/')) return;
    void this.call({ type: 'put', path: path.slice('ghost/master/'.length), data } as WorkerCall, REQUEST_TIMEOUT_MS).catch((e) => this.hooks.onLog(`SHIORI put: ${(e as Error).message}`));
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

  protected call(msg: WorkerCall, timeout: number, transfer: Transferable[] = []): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('SHIORI is not loaded'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SHIORI ${msg.type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  private onMessage(msg: WorkerReply): void {
    if (msg.type === 'write') {
      this.hooks.onWrite(`ghost/master/${msg.path}`, msg.data);
      return;
    }
    if (msg.type === 'log') {
      this.hooks.onLog(msg.message);
      return;
    }
    if (msg.type === 'saori') {
      this.hooks.onSaori?.(msg.effect);
      return;
    }
    if (msg.type === 'sstp') {
      // SSTP を送れるのは SHIOLINK の Node.js のプログラムだけ (ふつうの SHIORI の Worker からは受けない)
      const worker = this.worker;
      const send = this.acceptsSstp && typeof msg.request === 'string' && msg.request.length <= MAX_SSTP_LENGTH ? this.hooks.onSstp : undefined;
      void (send?.(msg.request) ?? Promise.resolve('SSTP/1.4 501 Not Implemented\r\n\r\n'))
        .catch(() => 'SSTP/1.4 500 Internal Server Error\r\n\r\n')
        .then((response) => worker?.postMessage({ type: 'sstp-response', id: msg.id, response }));
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
