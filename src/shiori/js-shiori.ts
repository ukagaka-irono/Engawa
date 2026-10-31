import type { FileTree } from '../vfs/files';
import type { Shiori, ShioriHooks } from './shiori';
import ShioriWorker from './shiori-worker.ts?worker&inline';
import { REQUEST_TIMEOUT_MS, WorkerShiori } from './worker-shiori';

/**
 * JavaScript で書かれた SHIORI。ghost/master/<shiori> を ES モジュールとして Web Worker 内で読み込む。
 * モジュールは `load(dir)`, `request(text)`, `unload()` を export する (request は Promise でもよい)。
 *
 * ゴーストの JavaScript は信頼できないので、Worker はこのページのオリジンを持たないように data: の URL から起こす
 * (blob: の Worker はページと同じオリジンになり、IndexedDB のほかのゴーストのデータやクッキー付きの通信に届いてしまう)。
 * data: の Worker を起こせないブラウザでは、これまでどおり blob: から起こす。
 */
export class JsShiori extends WorkerShiori implements Shiori {
  /** node があれば、SHIOLINK で Node.js のプログラムとして動かす (argv はスクリプトと引数。node-runtime.ts) */
  constructor(
    private readonly files: FileTree,
    readonly name: string,
    hooks: ShioriHooks,
    private readonly node?: { argv: string[] },
  ) {
    super(hooks);
  }

  async load(): Promise<void> {
    // Worker は Blob として埋め込む (file:// で開いた index.html からでも起動できるように)
    const master = this.files.sub('ghost/master');
    // Node.js のプログラムには、同梱の node.exe や DLL は要らない (大きいので Worker に写さない)
    const entries = [...master.entries()].filter(([p]) => !this.node || !/\.(exe|dll)$/i.test(p));
    const url = await isolatedWorkerUrl();
    if (!url) console.warn('[engawa] JavaScript の SHIORI を、オリジンを持たない Worker で動かせません (このページと同じオリジンで動かします)');
    return this.start(url ? new Worker(url, { name: this.name }) : new ShioriWorker(), { type: 'load', files: entries, entry: this.name, dir: 'ghost/master/', node: this.node } as never);
  }

  async request(text: string): Promise<string> {
    return ((await this.call({ type: 'request', text } as never, REQUEST_TIMEOUT_MS)) as string | undefined) ?? '';
  }

  unload(): Promise<void> {
    return this.stop({ type: 'unload' });
  }
}

let isolated: Promise<string | undefined> | undefined;

/** shiori-worker を起こす data: の URL。開発用のサーバー (Worker を別のモジュールとして読む) と、data: の Worker を起こせないときは undefined */
function isolatedWorkerUrl(): Promise<string | undefined> {
  return (isolated ??= (async () => {
    if (import.meta.env.DEV || typeof Worker === 'undefined') return undefined;
    try {
      if (!(await dataWorkerWorks())) return undefined;
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(await workerCode())}`;
    } catch {
      return undefined;
    }
  })());
}

/**
 * Vite が埋め込んだ shiori-worker のコード。埋め込みの Worker のコンストラクタは中身を blob: の URL にして new Worker に渡すので、
 * その間だけ Worker を差し替えて URL を受け取り、中身を読む
 */
async function workerCode(): Promise<string> {
  const Real = self.Worker;
  let src = '';
  class Capture {
    constructor(url: string | URL) {
      src = String(url);
    }
    addEventListener(): void {}
    terminate(): void {}
  }
  (self as unknown as { Worker: unknown }).Worker = Capture;
  try {
    new ShioriWorker();
  } finally {
    self.Worker = Real;
  }
  if (src.startsWith('data:')) return decodeURIComponent(src.slice(src.indexOf(',') + 1));
  try {
    return await (await fetch(src)).text();
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** data: の URL から Worker を起こし、返事が来るか試す (1度だけ) */
function dataWorkerWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker('data:text/javascript,postMessage(typeof indexedDB)');
    } catch {
      resolve(false);
      return;
    }
    const done = (ok: boolean) => {
      clearTimeout(timer);
      w.terminate();
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(false), 3000);
    w.onmessage = () => done(true);
    w.onerror = () => done(false);
  });
}
