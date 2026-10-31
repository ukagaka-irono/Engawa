import { encodeCharset } from '../util/charset-encode';
import { decodeText } from '../util/text';

/**
 * \![execute,http-get / http-post / http-head / http-put / http-delete / http-patch / http-options,URL,オプション…] と
 * \![execute,rss-get / rss-post,URL,…]。ブラウザの fetch で取るので、相手のサーバーが CORS を許していないと失敗する。
 */

export interface HttpRequest {
  /** get / post / head / put / delete / patch / options */
  method: string;
  rss: boolean;
  url: string;
  /** --async / --sync の識別子 (無ければ空) */
  id: string;
  /** 待つか (--sync か、どちらも無いとき) */
  sync: boolean;
  /** --nofile の文字コード。undefined ならファイルに保存する */
  nofile?: string;
  /** --file (ghost/master/var/ からの名前) */
  file?: string;
  params: string[];
  paramCharset: string;
  contentType: string;
  headers: [string, string][];
  timeout: number;
  /** --progress-notify: 取っている途中を OnExecuteHTTPProgress で知らせる */
  progress: boolean;
  /** --streaming: 届いた分を OnExecuteHTTPStreaming で知らせる */
  streaming: boolean;
}

export function parseHttp(sub: string, args: string[]): HttpRequest | undefined {
  const m = /^(http|rss)-(get|post|head|put|delete|patch|options)$/.exec(sub);
  const url = args[0]?.trim();
  if (!m || !url) return undefined;
  const req: HttpRequest = {
    method: m[2],
    rss: m[1] === 'rss',
    url,
    id: '',
    sync: true,
    params: [],
    paramCharset: 'UTF-8',
    contentType: 'application/x-www-form-urlencoded',
    headers: [],
    timeout: 60,
    progress: false,
    streaming: false,
  };
  let explicit = false;
  for (const raw of args.slice(1)) {
    const a = raw.trim();
    const o = /^--([\w-]+)(?:=(.*))?$/s.exec(a);
    if (!o) {
      // 古い書き方: 3番目の引数がパラメータ
      if (a) req.params.push(a);
      continue;
    }
    const key = o[1].toLowerCase();
    const value = o[2] ?? '';
    if (key === 'async' || key === 'sync') {
      req.id = value;
      req.sync = key === 'sync';
      explicit = true;
    } else if (key === 'nofile') req.nofile = value || 'UTF-8';
    else if (key === 'file') req.file = value;
    else if (key === 'param') req.params.push(value);
    else if (key === 'param-charset') req.paramCharset = value || 'UTF-8';
    else if (key === 'content-type') req.contentType = value;
    else if (key === 'header') {
      const i = value.indexOf(':');
      if (i > 0) req.headers.push([value.slice(0, i).trim(), value.slice(i + 1).trim()]);
    } else if (key === 'authorization') req.headers.push(['Authorization', value]);
    else if (key === 'accept') req.headers.push(['Accept', value]);
    else if (key === 'accept-language') req.headers.push(['Accept-Language', value]);
    else if (key === 'cookie') req.headers.push(['Cookie', value]);
    else if (key === 'no-cache') req.headers.push(['Cache-Control', 'no-cache']);
    else if (key === 'timeout') req.timeout = Math.min(300, Math.max(1, Number(value) || 60));
    else if (key === 'progress-notify') req.progress = true;
    else if (key === 'streaming') req.streaming = true;
  }
  if (!explicit) req.sync = true;
  return req;
}

/** 結果のイベントの名前 (--async=On… ならその名前と、失敗は …Failure) */
export function httpEvent(req: HttpRequest, ok: boolean): string {
  if (req.id.startsWith('On')) return ok ? req.id : `${req.id}Failure`;
  if (req.rss) return ok ? 'OnExecuteRSSComplete' : 'OnExecuteRSSFailure';
  return ok ? 'OnExecuteHTTPComplete' : 'OnExecuteHTTPFailure';
}

export interface HttpResult {
  ok: boolean;
  /** 200 など、または timeout・parse・fetch (ネットワークや CORS) */
  code: string;
  data?: Uint8Array;
  headers: string;
}

/** 送るパラメータ (urlencoded は &、ほかは改行でつなぐ) */
function body(req: HttpRequest): { body?: BodyInit; query?: string } {
  if (!req.params.length) return {};
  const encode = (s: string) => {
    const bytes = encodeCharset(s, req.paramCharset);
    return Array.from(bytes, (b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  };
  if (req.contentType === 'multipart/form-data') {
    const form = new FormData();
    for (const p of req.params) {
      const i = p.indexOf('=');
      if (i > 0) form.append(p.slice(0, i), p.slice(i + 1));
    }
    return { body: form };
  }
  const fields = req.params.every((p) => p.includes('='));
  const text =
    req.contentType === 'application/x-www-form-urlencoded' && fields
      ? req.params.map((p) => `${encode(p.slice(0, p.indexOf('=')))}=${encode(p.slice(p.indexOf('=') + 1))}`).join('&')
      : req.params.join('\r\n');
  if (req.method === 'get' || req.method === 'head' || req.method === 'delete' || req.method === 'options') return { query: text };
  return { body: encodeCharset(text, req.paramCharset) as BodyInit };
}

/** signal で取り消せる (\![cancel,http,URL]) */
export async function runHttp(req: HttpRequest, signal?: AbortSignal, onChunk?: (chunk: Uint8Array, received: number, total: number) => void): Promise<HttpResult> {
  const { body: data, query } = body(req);
  const url = query ? `${req.url}${req.url.includes('?') ? '&' : '?'}${query}` : req.url;
  const headers = new Headers(req.headers);
  if (data && !(data instanceof FormData)) headers.set('Content-Type', req.contentType);
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = window.setTimeout(() => controller?.abort(), req.timeout * 1000);
  signal?.addEventListener('abort', () => controller?.abort());
  try {
    const method = req.method === 'get' && req.rss ? 'GET' : req.method.toUpperCase();
    // 取得先はゴーストが決めるので、このページのクッキーは付けない (SSP の http-get にもブラウザのクッキーは無い)
    const res = await fetch(url, { method, headers, body: data, signal: controller?.signal, credentials: 'omit' });
    let bytes: Uint8Array;
    const reader = onChunk ? res.body?.getReader() : undefined;
    if (reader) {
      // 届いた分ずつ知らせる (--progress-notify・--streaming)
      const total = Number(res.headers.get('Content-Length')) || -1;
      const parts: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.length;
        onChunk!(value, received, total);
      }
      bytes = new Uint8Array(received);
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
    } else bytes = new Uint8Array(await res.arrayBuffer());
    const head: string[] = [];
    res.headers.forEach((v, k) => head.push(`${k}: ${v}`));
    return { ok: res.ok, code: String(res.status), data: bytes, headers: head.join('\x01') };
  } catch (e) {
    return { ok: false, code: (e as Error).name === 'AbortError' ? 'timeout' : 'fetch', headers: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** --nofile の Reference3 (改行はバイト値1に) */
export function nofileText(data: Uint8Array | undefined, charset: string): string {
  if (!data) return '';
  return decodeText(data.subarray(0, 128 * 1024), charset).replace(/\r\n|\r|\n/g, '\x01');
}

/** RSS / Atom を OnExecuteRSSComplete の Reference (タイトル\1URL\1年,月,日,時,分,秒\1作者\1内容) にする。読めなければ undefined */
export function parseFeed(data: Uint8Array): string[] | undefined {
  if (typeof DOMParser !== 'function') return undefined;
  const doc = new DOMParser().parseFromString(decodeText(data), 'application/xml');
  if (doc.querySelector('parsererror')) return undefined;
  const items = [...doc.querySelectorAll('item, entry')];
  if (!items.length && !doc.querySelector('rss, feed, RDF, rdf\\:RDF')) return undefined;
  const text = (el: Element, ...names: string[]) => {
    for (const n of names) {
      const found = [...el.children].find((c) => c.localName === n);
      if (found?.textContent) return found.textContent.trim();
    }
    return '';
  };
  const date = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(',');
  };
  return items.map((it) => {
    const link = [...it.children].find((c) => c.localName === 'link');
    const url = link?.getAttribute('href') ?? link?.textContent?.trim() ?? '';
    const author = text(it, 'author', 'creator');
    return [
      text(it, 'title'),
      url,
      date(text(it, 'pubDate', 'updated', 'published', 'date')),
      author.replace(/\s+/g, ' '),
      text(it, 'description', 'summary', 'content').replace(/\r\n|\r|\n/g, ' '),
    ].join('\x01');
  });
}

/**
 * \![execute,http-get,…] で保存する var/ の中の名前。%xx は戻すが、戻せなければそのまま。
 * .. や空の部分は除き、var/ の外 (シェル・download/ など) へ出られないようにする
 */
export function httpFileName(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // 壊れた %xx はそのまま
  }
  const parts = name
    .split(/[\\/]/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[:*?"<>|]/g, '_'));
  return parts.join('/') || 'index.html';
}
