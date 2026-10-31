import { encodeCharset } from '../util/charset-encode';
import { decodeText, normalizeCharset } from '../util/text';

/**
 * SAORI/1.0 の要求と応答 (http://www.boreas.dti.ne.jp/~sdn/saori.html)。
 *   EXECUTE SAORI/1.0            GET Version SAORI/1.0
 *   Charset: Shift_JIS           …
 *   Argument0: …
 * 応答は「SAORI/1.0 200 OK」と Result・Value0…。文字コードは要求の Charset に合わせる (無ければ Shift_JIS)。
 */

export interface SaoriRequest {
  /** "EXECUTE" か "GET Version" */
  method: string;
  /** Argument0, Argument1, … */
  args: string[];
  /** ヘッダ (名前は小文字) */
  headers: Map<string, string>;
  /** 応答に使う文字コード (TextDecoder・encodeCharset のラベル) */
  charset: string;
}

export interface SaoriResult {
  /** 既定は Result があれば 200、無ければ 204 */
  status?: 200 | 204 | 400 | 500;
  result?: string;
  values?: string[];
  /** 失敗の理由 (SAORI over DirectSSTP の ErrorDescription。固定の英語の文字列) */
  error?: string;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 500: 'Internal Server Error' };

/** ヘッダの Charset (ASCII なので latin1 で先頭だけ読めば足りる) */
export function declaredCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  return /^Charset:[ \t]*([\w-]+)/im.exec(head)?.[1];
}

export function parseSaoriRequest(bytes: Uint8Array): SaoriRequest {
  const declared = declaredCharset(bytes);
  const charset = declared && normalizeCharset(declared) !== 'shift_jis' ? declared : 'Shift_JIS';
  const lines = decodeText(bytes, charset).split(/\r?\n/);
  const method = (lines[0] ?? '').replace(/\s*SAORI\/[\d.]+\s*$/i, '').trim();
  const headers = new Map<string, string>();
  const args: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line) break;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/^ /, '');
    headers.set(name.toLowerCase(), value);
    const m = /^Argument(\d+)$/i.exec(name);
    if (m) args[Number(m[1])] = value;
  }
  // 抜けた番号は空文字列にする
  for (let i = 0; i < args.length; i++) args[i] ??= '';
  return { method, args, headers, charset };
}

export function buildSaoriResponse(res: SaoriResult, charset: string): Uint8Array {
  const status = res.status ?? (res.result !== undefined ? 200 : 204);
  const lines = [`SAORI/1.0 ${status} ${STATUS_TEXT[status]}`, `Charset: ${charset}`];
  // 値に改行があると応答が壊れるので、SSP と同じく取り除く
  const clean = (v: string) => v.replace(/\r?\n/g, ' ');
  if (res.result !== undefined) lines.push(`Result: ${clean(res.result)}`);
  if (res.error) lines.push(`ErrorDescription: ${clean(res.error)}`);
  res.values?.forEach((v, i) => lines.push(`Value${i}: ${clean(v)}`));
  return encodeCharset(`${lines.join('\r\n')}\r\n\r\n`, charset);
}

/**
 * SAORI の応答を、要求と同じ文字コードにする。SAORI には要求の Charset を見ずに決まった文字コードで答えるものがある
 * (BudouX は UTF-8 だけ、など)。末尾の NUL (Rust 製の SAORI が付ける) も取り除く。
 */
export function matchResponseCharset(req: Uint8Array, res: Uint8Array): Uint8Array {
  let end = res.length;
  while (end > 0 && res[end - 1] === 0) end--;
  const body = res.subarray(0, end);
  const want = declaredCharset(req) ?? 'Shift_JIS';
  const got = declaredCharset(body);
  if (!got || normalizeCharset(got) === normalizeCharset(want)) return body;
  const text = decodeText(body, got).replace(/^Charset:[ \t]*[\w-]+/im, `Charset: ${want}`);
  return encodeCharset(text, want);
}
