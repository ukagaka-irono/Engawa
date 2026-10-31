import { readSaoriEnv } from '../saori/context';
import { planWasmSaori } from '../saori/wasm-assets';
import { encodeCharset } from '../util/charset-encode';
import { decodeText, normalizeCharset } from '../util/text';
import type { FileTree } from '../vfs/files';
import type { NativeEngine } from './native-detect';
import { fromShiori2, toShiori2 } from './shiori2';
import NativeWorker from './native-worker.ts?worker&inline';
import type { Shiori, ShioriHooks } from './shiori';
import { REQUEST_TIMEOUT_MS, WorkerShiori } from './worker-shiori';

/** 要求の Charset ヘッダ (buildRequest は UTF-8 で作る) */
const CHARSET_HEADER = /^Charset: .*$/m;

/**
 * DLL 製 SHIORI (YAYA・里々・華和梨など) を WebAssembly にしたもの。native-worker.ts の中で動かす。
 * SSP と同じく、要求は SHIORI が最後に返した Charset (はじめは Shift_JIS) で送り、応答は応答の Charset で読む。
 * セーブデータは unload のほか、ページが隠れたとき・閉じるときにも書き戻す。
 */
export class NativeShiori extends WorkerShiori implements Shiori {
  private charset = 'Shift_JIS';
  private readonly flushOnHide = () => {
    if (document.visibilityState === 'hidden') void this.call({ type: 'flush' }, REQUEST_TIMEOUT_MS).catch(() => {});
  };
  /** SAORI (画面の大きさを答えるものなど) が読む様子を、窓の大きさが変わったら送り直す */
  private readonly sendEnv = () => {
    void this.call({ type: 'env', env: readSaoriEnv() } as never, REQUEST_TIMEOUT_MS).catch(() => {});
  };

  constructor(
    private readonly files: FileTree,
    readonly name: string,
    private readonly engine: NativeEngine,
    hooks: ShioriHooks,
  ) {
    super(hooks);
  }

  async load(): Promise<void> {
    // 埋め込みの wasm (gzip) は data: URL。file:// でも fetch で読める
    const wasm = new Uint8Array(await (await fetch(this.engine.wasmUrl)).arrayBuffer());
    const files = [...this.files.sub('ghost/master').entries()];
    // WebAssembly にした SAORI は、SHIORI が開く前に Worker の中で作っておく。里々は ssu.dll を自分の中のもので呼ぶ
    const saori = await planWasmSaori(this.files, this.name, this.engine.id === 'satori' ? ['ssu'] : []);
    const shellDirs = this.files.dirs('shell');
    await this.start(new NativeWorker(), { type: 'load', engine: this.engine.id, wasm, files, env: readSaoriEnv(), saori, shellDirs } as never, [wasm.buffer]);
    document.addEventListener('visibilitychange', this.flushOnHide);
    window.addEventListener('pagehide', this.flushOnHide);
    window.addEventListener('resize', this.sendEnv);
  }

  async request(text: string): Promise<string> {
    // SHIORI/2.x しか話さないもの (華和梨 7) には、2.x の要求に読み替えて送る
    if (this.engine.protocol === 2) {
      const req = toShiori2(text);
      if (!req) return 'SHIORI/3.0 204 No Content\r\nCharset: UTF-8\r\n\r\n';
      return fromShiori2(await this.send(req.text), req);
    }
    return this.send(text);
  }

  private async send(text: string): Promise<string> {
    const data = encodeCharset(text.replace(CHARSET_HEADER, `Charset: ${this.charset}`), this.charset);
    const res = (await this.call({ type: 'request', data } as never, REQUEST_TIMEOUT_MS, [data.buffer])) as Uint8Array;
    // ヘッダは ASCII なので latin1 で読めば足りる
    const head = new TextDecoder('latin1').decode(res.subarray(0, 1024));
    const declared = /^Charset:[ \t]*([\w-]+)/im.exec(head)?.[1];
    if (declared) this.charset = normalizeCharset(declared) === 'shift_jis' ? 'Shift_JIS' : declared;
    return decodeText(res, declared ?? this.charset);
  }

  /** SHIORI が書いたファイルをいま書き戻す (\![reload,shell] の前など) */
  async flush(): Promise<void> {
    await this.call({ type: 'flush' }, REQUEST_TIMEOUT_MS).catch(() => {});
  }

  unload(): Promise<void> {
    document.removeEventListener('visibilitychange', this.flushOnHide);
    window.removeEventListener('pagehide', this.flushOnHide);
    window.removeEventListener('resize', this.sendEnv);
    return this.stop({ type: 'unload' });
  }
}
