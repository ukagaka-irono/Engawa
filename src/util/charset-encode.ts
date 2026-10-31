import { normalizeCharset } from './text';

/**
 * 文字列を指定の文字コードのバイト列にする (DLL 製 SHIORI へ渡す要求に使う)。
 * ブラウザの TextEncoder は UTF-8 しか作れないので、Shift_JIS (CP932) は TextDecoder で全2バイト文字を
 * 一度読んで逆引きの表を作る。表に無い文字は SSP と同じく「?」にする。
 */

let sjisTable: Map<number, number> | undefined;

function sjis(): Map<number, number> {
  if (sjisTable) return sjisTable;
  const table = new Map<number, number>();
  const dec = new TextDecoder('shift_jis');
  const pair = new Uint8Array(2);
  // 先に1バイト目の範囲 (0x81-0x9F, 0xE0-0xFC) を2バイトで読み、後から半角を入れる。
  // 同じ文字が複数の符号を持つときは、先に見つかった方を残す。ただし NEC 選定 IBM 拡張 (0xED-0xEE) より
  // IBM 拡張 (0xFA-0xFC) を優先する (Encoding Standard の Shift_JIS エンコーダ、CP932 と同じ)
  const necSelected = (code: number) => code >> 8 === 0xed || code >> 8 === 0xee;
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    pair[0] = lead;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pair[1] = trail;
      const s = dec.decode(pair);
      if (s.length !== 1 || s === '�') continue;
      const code = s.charCodeAt(0);
      const known = table.get(code);
      if (known === undefined || (lead >= 0xfa && necSelected(known))) table.set(code, (lead << 8) | trail);
    }
  }
  for (let b = 0xa1; b <= 0xdf; b++) table.set(0xff61 + (b - 0xa1), b);
  sjisTable = table;
  return table;
}

function encodeSjis(text: string): Uint8Array {
  const table = sjis();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    // サロゲートペアは Shift_JIS に無いので1文字の「?」にする
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) i++;
    const code = c === 0xa5 ? 0x5c : c === 0x203e ? 0x7e : table.get(c);
    if (code === undefined) out[n++] = 0x3f;
    else if (code > 0xff) {
      out[n++] = code >> 8;
      out[n++] = code & 0xff;
    } else out[n++] = code;
  }
  return out.slice(0, n);
}

export function encodeCharset(text: string, charset: string): Uint8Array {
  const c = normalizeCharset(charset);
  if (c === 'shift_jis') return encodeSjis(text);
  // UTF-8 以外の未対応の文字コードも UTF-8 で送る (SHIORI 側が Charset ヘッダを見て読む)
  return new TextEncoder().encode(text);
}
