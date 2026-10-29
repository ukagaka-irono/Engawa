import type { FileTree } from '../vfs/files';
import type { Shiori, ShioriHooks } from './shiori';
import ShioriWorker from './shiori-worker.ts?worker&inline';
import { REQUEST_TIMEOUT_MS, WorkerShiori } from './worker-shiori';

/**
 * JavaScript で書かれた SHIORI。ghost/master/<shiori> を ES モジュールとして Web Worker 内で読み込む。
 * モジュールは `load(dir)`, `request(text)`, `unload()` を export する (request は Promise でもよい)。
 */
export class JsShiori extends WorkerShiori implements Shiori {
  constructor(
    private readonly files: FileTree,
    readonly name: string,
    hooks: ShioriHooks,
  ) {
    super(hooks);
  }

  load(): Promise<void> {
    // Worker は Blob として埋め込む (file:// で開いた index.html からでも起動できるように)
    const master = this.files.sub('ghost/master');
    return this.start(new ShioriWorker(), { type: 'load', files: [...master.entries()], entry: this.name, dir: 'ghost/master/' } as never);
  }

  async request(text: string): Promise<string> {
    return ((await this.call({ type: 'request', text } as never, REQUEST_TIMEOUT_MS)) as string | undefined) ?? '';
  }

  unload(): Promise<void> {
    return this.stop({ type: 'unload' });
  }
}
