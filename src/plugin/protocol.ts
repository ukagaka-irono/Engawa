import type { Reference } from '../shiori/protocol';

/**
 * PLUGIN/2.0 (ukadoc の spec/plugin)。書き方は SHIORI/3.0 にならう。
 * 要求は「GET PLUGIN/2.0」「NOTIFY PLUGIN/2.0」と ID・Reference、応答はゴーストに送るイベントとスクリプト
 */

export type PluginMethod = 'GET' | 'NOTIFY';

export interface PluginRequest {
  method: PluginMethod;
  id: string;
  references?: Reference[];
  /** \![raiseplugin] で呼ばれたときの、呼んだゴーストの名前 (本体から呼ぶときは付けない) */
  sender?: string;
}

export interface PluginResponse {
  status: number;
  headers: Map<string, string>;
  /** version の答え */
  value?: string;
  /** ゴーストに送るイベント */
  event?: string;
  /** notify ならイベントを NOTIFY で送る */
  eventOption: string[];
  references: string[];
  /** 送り先のゴーストの名前。__SYSTEM_ALL_GHOST__ なら起動中の全員 */
  target?: string;
  /** ゴーストがイベントに答えなかったときに再生する、既定のスクリプト */
  script?: string;
  /** nobreak (喋り終わるのを待つ)・notranslate */
  scriptOption: string[];
}

/** ヘッダの値に改行は書けないので、SHIORI と同じく \x01 にする */
function headerValue(v: string | number): string {
  return String(v).replace(/\r\n|\r|\n/g, '\x01');
}

export function buildPluginRequest(req: PluginRequest): string {
  const lines = [`${req.method} PLUGIN/2.0`, `ID: ${req.id}`, 'Charset: UTF-8'];
  if (req.sender !== undefined) lines.push(`Sender: ${headerValue(req.sender)}`);
  req.references?.forEach((r, i) => {
    if (r !== undefined) lines.push(`Reference${i}: ${headerValue(r)}`);
  });
  return `${lines.join('\r\n')}\r\n\r\n`;
}

const options = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function parsePluginResponse(text: string): PluginResponse {
  const lines = text.split(/\r\n|\r|\n/);
  const m = /^PLUGIN\/[\d.]+\s+(\d{3})/i.exec(lines[0]?.trim() ?? '');
  const headers = new Map<string, string>();
  const refs: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).replace(/^ /, '');
    const r = /^Reference(\d+)$/i.exec(key);
    if (r) refs[Number(r[1])] = value;
    else headers.set(key.toLowerCase(), value);
  }
  const nonEmpty = (k: string) => {
    const v = headers.get(k);
    return v === undefined || v === '' ? undefined : v;
  };
  return {
    status: m ? Number(m[1]) : 500,
    headers,
    value: nonEmpty('value'),
    event: nonEmpty('event'),
    eventOption: options(headers.get('eventoption')),
    references: Array.from(refs, (r) => r ?? ''),
    target: nonEmpty('target'),
    script: nonEmpty('script'),
    scriptOption: options(headers.get('scriptoption')),
  };
}
