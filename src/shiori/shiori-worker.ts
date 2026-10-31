/**
 * JavaScript SHIORI を動かす Web Worker。DOM には触れられない。
 * SHIORI からは `globalThis.engawa` でファイル入出力ができる (パスは ghost/master からの相対)。
 */
import { decodeText, encodeText } from '../util/text';
import { normalizePath } from '../vfs/files';
import { runModuleScript } from './module-script';
import { startNode } from './node-runtime';
import type { FromWorker, ToWorker } from './worker-protocol';

// globalThis は Safari 12.1 から。SHIORI が globalThis.engawa と書けるように
if (typeof globalThis === 'undefined') (self as unknown as { globalThis: unknown }).globalThis = self;

interface ShioriModule {
  load?(dir: string): unknown;
  request(text: string): string | Promise<string>;
  unload?(): unknown;
}

const ctx = self as unknown as {
  postMessage(msg: FromWorker): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const files = new Map<string, Uint8Array>();
const modules = new Map<string, Promise<unknown>>();
let shiori: ShioriModule | undefined;

/**
 * Worker の中で import() が動くか。Safari 14 以前などは構文ごと知らないので、文字列から関数を作って試す
 * (失敗しても Worker 全体は読み込める)。動かなければ module-script.ts で書き換えて動かす。
 */
const nativeImport: Promise<((url: string) => Promise<unknown>) | undefined> = (async () => {
  try {
    const load = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
    const probe = URL.createObjectURL(new Blob(['export const ok = 1;'], { type: 'text/javascript' }));
    try {
      const mod = (await load(probe)) as { ok?: number };
      return mod.ok === 1 ? load : undefined;
    } finally {
      URL.revokeObjectURL(probe);
    }
  } catch {
    return undefined;
  }
})();

function importModule(path: string): Promise<unknown> {
  const p = normalizePath(path);
  let mod = modules.get(p);
  if (!mod) {
    const data = files.get(p);
    if (!data) return Promise.reject(new Error(`module not found: ${path}`));
    mod = nativeImport.then((load) =>
      load ? load(URL.createObjectURL(new Blob([data as BlobPart], { type: 'text/javascript' }))) : runModuleScript(decodeText(data, 'utf-8'), p),
    );
    modules.set(p, mod);
  }
  return mod;
}

const host = {
  exists: (path: string) => files.has(normalizePath(path)),
  list: (prefix = '') => {
    const head = normalizePath(prefix);
    return [...files.keys()].filter((k) => !head || k === head || k.startsWith(head + '/'));
  },
  readText: (path: string, charset?: string) => {
    const data = files.get(normalizePath(path));
    return data ? decodeText(data, charset) : undefined;
  },
  readBinary: (path: string) => files.get(normalizePath(path)),
  writeText: (path: string, text: string) => host.writeBinary(path, encodeText(text)),
  writeBinary: (path: string, data: Uint8Array) => {
    const p = normalizePath(path);
    files.set(p, data);
    ctx.postMessage({ type: 'write', path: p, data });
  },
  log: (...args: unknown[]) => ctx.postMessage({ type: 'log', message: args.map(String).join(' ') }),
  importModule,
};
(self as unknown as { engawa: typeof host }).engawa = host;

/** SSTP の答えを待っているもの (Node.js のプログラムの SSTP over HTTP) */
const sstpWaiting = new Map<number, (response: string) => void>();
let sstpSeq = 0;

/**
 * SHIOLINK で動かす Node.js のプログラムを、SHIORI と同じ形にする。
 * 要求は「*S:番号」の後に送り、プログラムが「*S:番号」を返した後の、空行までを応答とする
 */
function nodeShiori(argv: string[]): ShioriModule {
  let pending: { echo: string; buf: string; resolve(text: string): void } | undefined;
  const node = startNode(
    {
      files,
      stdout: (t) => {
        if (!pending) return;
        pending.buf += t;
        let b = pending.buf;
        if (b.startsWith(pending.echo)) b = b.slice(pending.echo.length);
        else if (pending.echo.startsWith(b)) return;
        const end = b.indexOf('\r\n\r\n');
        if (end < 0) return;
        const done = pending;
        pending = undefined;
        done.resolve(b.slice(0, end + 4));
      },
      stderr: (t) => ctx.postMessage({ type: 'log', message: t.trimEnd() }),
      write: (path, data) => ctx.postMessage({ type: 'write', path, data }),
      sstp: (request) =>
        new Promise((resolve) => {
          const id = ++sstpSeq;
          sstpWaiting.set(id, resolve);
          ctx.postMessage({ type: 'sstp', id, request });
        }),
    },
    argv,
    { globals: true },
  );
  let seq = 0;
  return {
    load(dir) {
      node.stdin(`*L:/${dir}\r\n`);
    },
    request(text) {
      const id = `${++seq}`;
      return new Promise((resolve) => {
        pending = { echo: `*S:${id}\r\n`, buf: '', resolve };
        node.stdin(`*S:${id}\r\n${text.endsWith('\r\n\r\n') ? text : `${text.replace(/(\r\n)*$/, '')}\r\n\r\n`}`);
      });
    },
    unload() {
      node.stdin('*U:\r\n');
    },
  };
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'sstp-response') {
    sstpWaiting.get(msg.id)?.(msg.response);
    sstpWaiting.delete(msg.id);
    return;
  }
  try {
    let value: string | undefined;
    switch (msg.type) {
      case 'load': {
        for (const [p, d] of msg.files) files.set(p, d);
        if (msg.node) {
          const mod = nodeShiori(msg.node.argv);
          await mod.load?.('');
          shiori = mod;
          break;
        }
        const mod = (await importModule(msg.entry)) as ShioriModule;
        if (typeof mod.request !== 'function') throw new Error(`${msg.entry} does not export request()`);
        // load() が終わるまでは request を受け付けない
        await mod.load?.(msg.dir);
        shiori = mod;
        break;
      }
      case 'request':
        if (!shiori) throw new Error('SHIORI is not loaded');
        value = String(await shiori.request(msg.text));
        break;
      case 'put':
        files.set(normalizePath(msg.path), msg.data);
        break;
      case 'unload':
        await shiori?.unload?.();
        shiori = undefined;
        break;
    }
    ctx.postMessage({ id: msg.id, type: 'result', ok: true, value });
  } catch (err) {
    ctx.postMessage({ id: msg.id, type: 'result', ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
