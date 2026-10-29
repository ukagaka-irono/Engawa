export type ShioriMethod = 'GET' | 'NOTIFY';
export type Reference = string | number | undefined;

export interface ShioriRequest {
  method: ShioriMethod;
  id: string;
  references?: Reference[];
  headers?: Record<string, string>;
}

export interface ShioriResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  value?: string;
}

export const SENDER = 'Engawa';

/** ヘッダ値に改行は入れられないので、SSP と同じく \x01 に置き換える。 */
function headerValue(v: string | number): string {
  return String(v).replace(/\r\n|\r|\n/g, '\x01');
}

export function buildRequest(req: ShioriRequest): string {
  const lines = [
    `${req.method} SHIORI/3.0`,
    'Charset: UTF-8',
    `Sender: ${SENDER}`,
    'SecurityLevel: local',
    `ID: ${req.id}`,
  ];
  for (const [k, v] of Object.entries(req.headers ?? {})) lines.push(`${k}: ${headerValue(v)}`);
  req.references?.forEach((r, i) => {
    if (r !== undefined) lines.push(`Reference${i}: ${headerValue(r)}`);
  });
  return lines.join('\r\n') + '\r\n\r\n';
}

export function parseResponse(text: string): ShioriResponse {
  const lines = text.split(/\r\n|\n/);
  const m = /^SHIORI\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(lines[0]?.trim() ?? '');
  const res: ShioriResponse = {
    status: m ? Number(m[1]) : 500,
    statusText: m ? m[2] : 'Bad Response',
    headers: new Map(),
  };
  for (const line of lines.slice(1)) {
    if (line === '') break;
    const i = line.indexOf(':');
    if (i < 0) continue;
    res.headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).replace(/^ /, ''));
  }
  const value = res.headers.get('value');
  if (res.status === 200 && value !== undefined && value !== '') res.value = value;
  return res;
}
