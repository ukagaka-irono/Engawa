/**
 * JavaScript SHIORI を動かす Web Worker。DOM には触れられない。
 * SHIORI からは `globalThis.engawa` でファイル入出力ができる (パスは ghost/master からの相対)。
 */
import { decodeText, encodeText } from '../util/text';
import { normalizePath } from '../vfs/files';
import type { FromWorker, ToWorker } from './worker-protocol';

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
const moduleUrls = new Map<string, string>();
let shiori: ShioriModule | undefined;

function importModule(path: string): Promise<unknown> {
  const p = normalizePath(path);
  let url = moduleUrls.get(p);
  if (!url) {
    const data = files.get(p);
    if (!data) return Promise.reject(new Error(`module not found: ${path}`));
    url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'text/javascript' }));
    moduleUrls.set(p, url);
  }
  return import(/* @vite-ignore */ url);
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
(globalThis as unknown as { engawa: typeof host }).engawa = host;

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    let value: string | undefined;
    switch (msg.type) {
      case 'load': {
        for (const [p, d] of msg.files) files.set(p, d);
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
