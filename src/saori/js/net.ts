import { decodeText } from '../../util/text';
import type { SaoriContext } from '../context';
import { findFile, normalizePath, type JsSaori } from '../host';

/**
 * ネットワークを使う SAORI。SAORI は Worker の中で同期で答えるので、同期の XMLHttpRequest で取る
 * (Worker では同期の要求が許されている)。相手のサーバーが CORS を許していないと失敗する。
 */

interface Fetched {
  ok: boolean;
  status: number;
  data?: Uint8Array;
  /** Content-Type の charset */
  charset?: string;
  error?: string;
}

/** SAORI が同期で取るときに待つ長さ */
const FETCH_TIMEOUT_MS = 30_000;

/** 同期で取る。XMLHttpRequest の無いところ (テストなど) では失敗する */
export function fetchSync(url: string, method = 'GET', body?: string): Fetched {
  if (typeof XMLHttpRequest === 'undefined') return { ok: false, status: 0, error: 'XMLHttpRequest がありません' };
  try {
    // 同じオリジンへの XMLHttpRequest はクッキーを外せないので、Engawa を置いたサイトそのものからは取らない
    const here = typeof location === 'undefined' ? undefined : location;
    if (here && /^https?:$/.test(here.protocol) && new URL(url, here.href).origin === here.origin) {
      return { ok: false, status: 0, error: 'Engawa と同じサイトの URL は取れません' };
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    xhr.responseType = 'arraybuffer';
    // 同期なので、応答の遅いサーバーで SHIORI の Worker が止まり続けないように (Worker の中では同期でも効く)
    xhr.timeout = FETCH_TIMEOUT_MS;
    xhr.send(body ?? null);
    const charset = /charset=([\w-]+)/i.exec(xhr.getResponseHeader('Content-Type') ?? '')?.[1];
    const data = xhr.response instanceof ArrayBuffer ? new Uint8Array(xhr.response) : undefined;
    return { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, charset, error: xhr.status ? `HTTP ${xhr.status}` : undefined };
  } catch (e) {
    // CORS・ネットワークの失敗は区別できない
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * saori_curl (ninix-saori)。Argument0 の URL から UTF-8 の文字を取る。
 *   Result: 取れたら OK、失敗したら理由。Value*: 取ったものを行に分けたもの
 */
export function saoriCurl(): JsSaori {
  return {
    execute({ args }) {
      const url = args[0];
      if (!url) return { status: 204 };
      const res = fetchSync(url);
      const text = res.data ? new TextDecoder('utf-8').decode(res.data).replace(/\r/g, '') : '';
      const lines = text ? text.split('\n') : [];
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return { result: res.ok ? 'OK' : (res.error ?? 'error'), values: lines };
    },
  };
}

/** HTML のタグを外し、実体参照を戻す */
function stripTags(html: string, removeTags: string[] = []): string {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  for (const t of removeTags) s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, 'gi'), '');
  return decodeEntities(s.replace(/<[^>]*>/g, ''));
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] ?? m;
  });
}

/** HTML をさくらスクリプトに (改行・段落・リンクだけ。入れ子のタグは中身の文字だけ) */
function translateHtml(html: string, removeTags: string[], base: string): string {
  let s = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  for (const t of removeTags) s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, 'gi'), '');
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/\\/g, '\\\\').replace(/%/g, '\\%');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    let url = href;
    try {
      url = new URL(decodeEntities(href), base).href;
    } catch {
      // そのまま
    }
    return `\\_a[${url.replace(/[\]\\]/g, '')}]${stripTags(text)}\\_a`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\\n').replace(/<\/(p|div|li|h[1-6]|tr|dt|dd)>/gi, '\\n').replace(/<(p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\\n[half]');
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/ {2,}/g, ' ').trim();
}

/** start= と end= の間 (multiSearch ならすべて、バイト値2でつなぐ) */
function between(text: string, start: string | undefined, end: string | undefined, multi: boolean): string {
  if (start === undefined && end === undefined) return text;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = start ? text.indexOf(start, from) : from;
    if (i < 0) break;
    const s = i + (start?.length ?? 0);
    const j = end ? text.indexOf(end, s) : text.length;
    if (j < 0) break;
    out.push(text.slice(s, j));
    from = j + (end?.length ?? 0);
    if (!multi || !start) break;
  }
  return out.join('\x02');
}

/**
 * chttpc.dll (CSaori。里々の httpc を作り直したもの)。
 *   (引数なし)            ネットにつながっていれば 1、でなければ 0
 *   URL [オプション…]     取ったものを返す。オプションは translate・strip・codepage=・save=・saveUtf8=・saveParsed=・
 *                         start=・end=・noOutput・removeTags=・multiSearch。hwnd= と id= の後で知らせる使い方はできないので、その場で返す
 * file: で始まる URL は DLL のディレクトリのファイルを読む。保存したファイルは DLL のディレクトリに書く
 */
export function chttpc(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      if (args.length === 0) return { result: online() ? '1' : '0' };
      const url = args[0];
      const opts = new Map<string, string>();
      for (const a of args.slice(1)) {
        const i = a.indexOf('=');
        opts.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? '' : a.slice(i + 1));
      }
      let data: Uint8Array | undefined;
      let charset = opts.get('codepage');
      if (/^file:/i.test(url)) {
        const found = findFile(ctx.fs, normalizePath(url.slice(5).replace(/^\/+/, ''), ctx.dir));
        data = found ? ctx.fs.readFile(found) : undefined;
      } else {
        const res = fetchSync(url);
        if (res.ok) data = res.data;
        charset ??= res.charset;
      }
      if (!data) return { status: 500 };
      let text = decodeText(data, charset && !/^\d+$/.test(charset) ? charset : (/<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(data.subarray(0, 4096)))?.[1] ?? undefined));
      const save = (name: string | undefined, bytes: Uint8Array) => {
        if (!name) return;
        const path = normalizePath(name, ctx.dir);
        ctx.fs.writeFile(path, bytes);
        ctx.post({ kind: 'write', path: path.slice(1), data: bytes.slice() });
      };
      save(opts.get('save'), data);
      save(opts.get('saveutf8'), new TextEncoder().encode(text));
      const removeTags = (opts.get('removetags') ?? '').split(',').filter(Boolean);
      text = between(text, opts.get('start'), opts.get('end'), opts.has('multisearch'));
      if (opts.has('translate')) text = translateHtml(text, removeTags, /^https?:/i.test(url) ? url : 'http://localhost/');
      else if (opts.has('strip')) text = stripTags(text, removeTags).replace(/\s+/g, ' ').trim();
      else if (opts.size) text = text.replace(/\r?\n/g, ' ');
      save(opts.get('saveparsed'), new TextEncoder().encode(text));
      if (opts.has('nooutput')) return { status: 204 };
      return { result: text };
    },
  };
}

/**
 * httpc.dll (櫛ヶ浜やぎ。satoriya/httpc/httpc.cpp)。先頭に並べたオプション (euc・jis・sjis・utf8・erase_tag・translate_tag) の後に
 *   (なし)            ネットにつながっていれば 1、でなければ 0
 *   URL               取った中身
 *   URL,ファイル      DLL のディレクトリのファイルに保存して 1 (できなければ 0)
 *   URL,前,後         前と後に挟まれたところ (2つ目からは Value0…)
 * 最初に bg,ID を付けると、結果を OnHttpcNotify (R0 = ID、R1 = -、R2 = 結果、R3… = 2つ目から) で知らせ、その場では空を返す。
 * SSP も内蔵している (ukadoc の spec/saori-ex の互換モジュール)
 */
export function httpc(ctx: SaoriContext): JsSaori {
  const OPTIONS = ['euc', 'jis', 'sjis', 'utf8', 'erase_tag', 'translate_tag'];
  const CHARSETS: Record<string, string> = { euc: 'euc-jp', jis: 'iso-2022-jp', sjis: 'shift_jis', utf8: 'utf-8' };
  const get = (url: string, opts: Set<string>): string | undefined => {
    const res = fetchSync(url);
    if (!res.ok || !res.data) return undefined;
    const named = [...opts].find((o) => CHARSETS[o]);
    let text = decodeText(res.data, named ? CHARSETS[named] : res.charset);
    if (opts.has('translate_tag')) text = translateHtml(text, [], url);
    else if (opts.has('erase_tag')) text = stripTags(text);
    return text;
  };
  const run = (args: string[]): { result: string; values: string[] } => {
    const opts = new Set<string>();
    while (args.length && OPTIONS.includes(args[0])) opts.add(args.shift()!);
    if (args.length === 0) return { result: online() ? '1' : '0', values: [] };
    if (args.length === 1) return { result: get(args[0], opts) ?? '', values: [] };
    if (args.length === 2) {
      const res = fetchSync(args[0]);
      if (!res.ok || !res.data) return { result: '0', values: [] };
      const path = normalizePath(args[1], ctx.dir);
      try {
        ctx.fs.writeFile(path, res.data);
      } catch {
        // フォルダが無い・フォルダの名前だったなど
        return { result: '0', values: [] };
      }
      ctx.post({ kind: 'write', path: path.slice(1), data: res.data.slice() });
      return { result: '1', values: [] };
    }
    let data = get(args[0], opts);
    if (data === undefined) return { result: '', values: [] };
    // 前も後も空だと同じところを取り続けて止まらない (元の httpc も同じ) ので、何も取らない
    if (!args[1] && !args[2]) return { result: '', values: [] };
    const found: string[] = [];
    for (;;) {
      const s = data.indexOf(args[1]);
      if (s < 0) break;
      data = data.slice(s + args[1].length);
      const e = data.indexOf(args[2]);
      if (e < 0) break;
      found.push(data.slice(0, e));
      data = data.slice(e + args[2].length);
    }
    return { result: found[0] ?? '', values: found.slice(1) };
  };
  return {
    execute({ args }) {
      if (args[0] === 'bg') {
        const id = args[1];
        if (id === undefined) return { result: 'bgするならIDを指定していただけませんと。' };
        const r = run(args.slice(2));
        ctx.post({ kind: 'event', id: 'OnHttpcNotify', refs: [id, '-', r.result, ...r.values] });
        return { result: '' };
      }
      const r = run([...args]);
      return { result: r.result, values: r.values };
    },
  };
}

/**
 * saori_ip (ip.dll)。ブラウザからはこの機械の IP アドレスと名前は分からない。
 * GetInternetIP は元の SAORI と同じ所に聞く (CORS を許していなければ失敗)
 */
export function saoriIp(): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd.startsWith('getlocalip')) return { result: '127.0.0.1' };
      if (cmd.startsWith('getlocalhostname')) return { result: typeof location === 'undefined' ? 'localhost' : location.hostname || 'localhost' };
      if (cmd.startsWith('getinternetip')) {
        const res = fetchSync('http://usada.sakura.vg/ip.php');
        const ip = res.ok && res.data ? /\d+\.\d+\.\d+\.\d+|[0-9a-f:]{3,}/i.exec(new TextDecoder().decode(res.data))?.[0] : undefined;
        return ip ? { result: ip } : { status: 500 };
      }
      return { status: 400 };
    },
  };
}

/**
 * iptools.dll (CSaori)。ネットワークの設定 (adapter)・DNS・whois・ダイヤルアップ (ras_*) はブラウザからは触れない。
 * adapter はブラウザから分かることだけ、flushdns は何もせず成功、ほかは失敗として答える
 */
export function ipTools(): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (!cmd) return { status: 400 };
      if (cmd.startsWith('hwnd')) return { status: 204 };
      if (cmd.startsWith('flushdns')) return { result: '1' };
      if (cmd.startsWith('adapter')) {
        const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type ?? 'unknown';
        return { result: '1', values: [`Browser\x01${type}\x01127.0.0.1\x01255.0.0.0\x01\x01`] };
      }
      if (cmd.startsWith('ras_enum')) return { result: '0' };
      return { status: 400 };
    },
  };
}

/**
 * uds.dll (UpDownSpeed)。ネットワークの口は1つ (Browser) として答え、速さはブラウザの見積もり (下りだけ) を使う
 */
export function uds(): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'listint') {
        return Number(args[1]) ? { result: '[0]: Browser\n' } : { result: 'OK', values: ['Browser'] };
      }
      if (cmd === 'updownspeed') {
        const mbps = (navigator as Navigator & { connection?: { downlink?: number } }).connection?.downlink ?? 0;
        const down = Math.round((mbps * 1_000_000) / 8);
        return Number(args[3]) ? { result: `Down: ${down} Bps, Up: 0 Bps.` } : { result: 'OK', values: [String(down), '0'] };
      }
      return { result: 'NG', values: ['Error. RetCode=1'] };
    },
  };
}
