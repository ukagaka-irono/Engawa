import type { Reference } from '../shiori/protocol';
import type { PackageMeta } from '../vfs/storage';
import type { Ghost } from './ghost';

/**
 * SSTP (ukadoc の spec/sstp)。ブラウザではポート 9801 で待てないので、postMessage と window.engawa.sstp で受ける。
 * よそのページからのものは非ローカル (SecurityLevel: external、OnTranslate などの種類は remote)。
 */

export interface SstpRequest {
  method: string;
  version: string;
  headers: [string, string][];
}

export interface SstpHost {
  ghosts(): Ghost[];
  current(): Ghost | undefined;
  installed(): PackageMeta[];
  /** オプションで受けないことにした */
  refused(): boolean;
  /** EXECUTE の SetCookie / GetCookie (送り主ごと) */
  cookies: Record<string, Record<string, string>>;
  saveCookies(): void;
  version: string;
}

const STATUS: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  210: 'Break',
  400: 'Bad Request',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  420: 'Refuse',
  501: 'Not Implemented',
  503: 'Service Unavailable',
  505: 'Version Not Supported',
  512: 'Invisible',
};

export function parseSstp(text: string): SstpRequest | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  const m = /^(\w+)\s+SSTP\/(\d+\.\d+)$/i.exec(lines[0]?.trim() ?? '');
  if (!m) return undefined;
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    const i = line.indexOf(':');
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).replace(/^ /, '')]);
  }
  return { method: m[1].toUpperCase(), version: m[2], headers };
}

function response(code: number, headers: [string, string][] = [], data = ''): string {
  const lines = [`SSTP/1.4 ${code} ${STATUS[code] ?? ''}`.trim(), 'Charset: UTF-8', ...headers.map(([k, v]) => `${k}: ${v}`)];
  return `${lines.join('\r\n')}\r\n\r\n${data ? `${data}\r\n` : ''}`;
}

function header(req: SstpRequest, name: string): string | undefined {
  return req.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

/** Reference0… を番号順に */
function references(req: SstpRequest): Reference[] {
  const refs: Reference[] = [];
  for (const [k, v] of req.headers) {
    const m = /^Reference(\d+)$/i.exec(k);
    if (m) refs[Number(m[1])] = v;
  }
  return Array.from(refs, (r) => r ?? '');
}

/** IfGhost と Script の組から、そのゴースト用のスクリプトを選ぶ (無ければ既定の Script) */
export function scriptFor(req: SstpRequest, ghost: { sakuraName: string; keroName: string }): string | undefined {
  let fallback: string | undefined;
  let pending: string | undefined;
  let chosen: string | undefined;
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    if (key === 'ifghost') pending = v;
    else if (key === 'script') {
      if (pending === undefined) fallback ??= v;
      else {
        const [s, k1] = pending.split(',').map((x) => x.trim());
        if (chosen === undefined && s === ghost.sakuraName && (k1 === undefined || k1 === ghost.keroName)) chosen = v;
        pending = undefined;
      }
    }
  }
  return chosen ?? fallback;
}

/** 宛先 (ReceiverGhostName・Ghost・IfGhost・ID)。無ければ選択中のゴースト */
function target(req: SstpRequest, host: SstpHost): Ghost | undefined | null {
  const ghosts = host.ghosts().filter((g) => g.alive && !g.leaving);
  const id = header(req, 'ID');
  if (id) return ghosts.find((g) => g.uniqueId === id) ?? null;
  const name = header(req, 'ReceiverGhostName') ?? header(req, 'Ghost');
  if (name) return ghosts.find((g) => g.sakuraName === name || g.name === name) ?? null;
  // IfGhost の名前のゴーストが起動していれば、そのゴーストへ
  for (const [k, v] of req.headers) {
    if (k.toLowerCase() !== 'ifghost') continue;
    const s = v.split(',')[0].trim();
    const g = ghosts.find((x) => x.sakuraName === s);
    if (g) return g;
  }
  const cur = host.current();
  return cur && cur.alive && !cur.leaving ? cur : ghosts[0];
}

/** 再生が終わるまで待つ (Option: nobreak) */
async function idle(g: Ghost, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (g.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  return !g.busy;
}

/**
 * SSTP の要求を処理して応答を返す。local は同じページから (window.engawa.sstp)。
 * origin はよそのページから postMessage で送られたときの送り元 (SSTP のクッキーを送り元ごとに分ける)
 */
export async function handleSstp(text: string, host: SstpHost, local: boolean, origin = ''): Promise<string> {
  const req = parseSstp(text);
  if (!req) return response(400);
  const v = Number(req.version);
  if (!(v >= 1 && v < 3)) return response(505);
  const sender = header(req, 'Sender') ?? header(req, 'User-Agent');
  if (!sender && req.method !== 'EXECUTE') return response(400);
  if (host.refused() && !local) return response(420);
  const options = (header(req, 'Option') ?? '').toLowerCase().split(',').map((s) => s.trim());
  const owned = !!header(req, 'ID');
  const kinds = [req.method === 'COMMUNICATE' ? 'communicate' : 'sstp-send', ...(owned ? ['owned'] : []), ...(local || owned ? [] : ['remote'])];
  const securityLevel = local || owned ? (header(req, 'SecurityLevel') ?? 'local') : 'external';

  if (req.method === 'EXECUTE') return execute(req, host, local, local ? (sender ?? '') : `${origin}\x01${sender ?? ''}`);

  const g = target(req, host);
  if (g === null) return response(404);
  if (!g) return response(503);
  if (g.isMinimized) return response(512);
  if (g.locked && !owned) return response(409);
  if (options.includes('nobreak') && !(await idle(g))) return response(409);
  const extra: Record<string, string> = { Sender: sender ?? '', SecurityLevel: securityLevel };
  for (const [k, val] of req.headers) if (/^X-SSTP-PassThru-/i.test(k)) extra[k] = val;
  const noTranslate = options.includes('notranslate');
  const marker = options.includes('nodescript') && (local || owned) ? undefined : (sender ?? '');

  if (req.method === 'SEND' || req.method === 'NOTIFY') {
    const event = header(req, 'Event');
    if (event) {
      const method = options.includes('notify') ? 'NOTIFY' : 'GET';
      const value = await g.request(method, event, references(req), extra);
      if (value && method === 'GET') {
        void g.playScript(value, { event, refs: references(req), kinds, sstpSender: marker, noTranslate });
        return response(200, [['Script', value.replace(/\r?\n/g, '')]]);
      }
    }
    const script = scriptFor(req, g);
    if (!script) return response(event ? 204 : 400);
    void g.playScript(script, { kinds, sstpSender: marker, noTranslate });
    return response(200, [['Script', script.replace(/\r?\n/g, '')]]);
  }
  if (req.method === 'COMMUNICATE') {
    const sentence = header(req, 'Sentence') ?? '';
    const refs: Reference[] = [sender ?? '', sentence, ...references(req)];
    const value = await g.request('GET', 'OnCommunicate', refs, { ...extra, ...(header(req, 'Surface') ? { Surface: header(req, 'Surface')! } : {}) });
    if (!value) return response(204);
    void g.playScript(value, { event: 'OnCommunicate', refs, kinds, sstpSender: marker, noTranslate });
    return response(200, [['Script', value.replace(/\r?\n/g, '')]]);
  }
  if (req.method === 'GIVE') {
    const doc = header(req, 'Document');
    const song = header(req, 'Song');
    const [id, refs] = doc !== undefined ? ['OnCommunicate', [sender ?? '', doc]] : song !== undefined ? ['OnMusicPlay', [song]] : ['', []];
    if (!id) return response(400);
    const value = await g.request('GET', id as string, refs as Reference[], extra);
    if (!value) return response(204);
    void g.playScript(value, { event: id as string, kinds, sstpSender: marker });
    return response(200);
  }
  return response(501);
}

/**
 * よそのページからの EXECUTE で使えるもの。名前・版・状態だけを答える。
 * プロパティ (developer.log に入力の中身なども入る) や設定の変更、ファイルの書き出しは同じページからだけ
 */
const REMOTE_EXECUTE = new Set(['getname', 'getghostname', 'getshellname', 'getballoonname', 'getversion', 'getshortversion', 'getstatus', 'setcookie', 'getcookie', 'quiet', 'restore']);

/** sender はクッキーの持ち主 (よそのページからは送り元のオリジンと Sender の組) */
async function execute(req: SstpRequest, host: SstpHost, local: boolean, sender: string): Promise<string> {
  const raw = header(req, 'Command') ?? '';
  const m = /^([\w]+)(?:\[(.*)\])?$/.exec(raw.trim());
  if (!m) return response(400);
  const command = m[1].toLowerCase();
  if (!local && !REMOTE_EXECUTE.has(command)) return response(420);
  const params = m[2] !== undefined ? m[2].split(',') : references(req).map(String);
  const g = target(req, host);
  const all = host.installed();
  const lines = (list: string[]) => `${list.join('\r\n')}\r\n`;
  switch (command) {
    case 'getname':
      return g ? response(200, [], `${g.sakuraName},${g.keroName}`) : response(404);
    case 'getghostname':
      return g ? response(200, [], g.name) : response(404);
    case 'getshellname':
      return g ? response(200, [], g.shell.name) : response(404);
    case 'getballoonname':
      return g ? response(200, [], g.skin.name) : response(404);
    case 'getnames':
      return response(200, [], lines(all.filter((p) => p.kind === 'ghost').map((p) => p.sakuraName ?? p.name)));
    case 'getghostnamelist':
      return response(200, [], lines(all.filter((p) => p.kind === 'ghost').map((p) => p.name)));
    case 'getballoonnamelist':
      return response(200, [], lines(['内蔵バルーン', ...all.filter((p) => p.kind === 'balloon').map((p) => p.name)]));
    case 'getshellnamelist':
      return g ? response(200, [], lines(g.shellDirs)) : response(404);
    case 'getheadlinenamelist':
    case 'getpluginnamelist':
      return response(200, [], '\r\n');
    case 'getversion':
      return response(200, [], `Engawa ${host.version}`);
    case 'getshortversion':
      return response(200, [], host.version);
    case 'getstatus': {
      const s = g?.status() ?? '';
      return response(s ? 200 : 204, [], s);
    }
    case 'getproperty':
      return g ? response(200, [], g.property(params[0] ?? '')) : response(404);
    case 'setproperty':
      if (!local) return response(420);
      if (!g) return response(404);
      await g.command(['set', 'property', params[0] ?? '', params.slice(1).join(',')], 0);
      return response(204);
    case 'setcookie':
      (host.cookies[sender] ??= {})[params[0] ?? ''] = params.slice(1).join(',');
      host.saveCookies();
      return response(204);
    case 'getcookie':
      return response(200, [], host.cookies[sender]?.[params[0] ?? ''] ?? '');
    case 'quiet':
    case 'restore':
      return response(204);
    case 'moveasync':
    case 'settrayicon':
    case 'settrayballoon':
    case 'dumpsurface':
    case 'extractarchive':
    case 'compressarchive': {
      if (!local) return response(420);
      if (!g) return response(404);
      const map: Record<string, string[]> = {
        moveasync: ['moveasync'],
        settrayicon: ['set', 'tasktrayicon'],
        settrayballoon: ['set', 'trayballoon'],
        dumpsurface: ['execute', 'dumpsurface'],
        extractarchive: ['execute', 'extractarchive'],
        compressarchive: ['execute', 'compressarchive'],
      };
      await g.command([...map[command], ...params], 0);
      return response(204);
    }
  }
  return response(501);
}
