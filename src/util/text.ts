const decoders = new Map<string, TextDecoder>();

function decoder(label: string, fatal = false): TextDecoder {
  const key = `${label}:${fatal}`;
  let d = decoders.get(key);
  if (!d) {
    d = new TextDecoder(label, { fatal });
    decoders.set(key, d);
  }
  return d;
}

/** descript.txt などの `charset,` 指定を TextDecoder のラベルに直す。 */
export function normalizeCharset(charset: string): string {
  const c = charset.trim().toLowerCase().replace(/_/g, '-');
  if (['shift-jis', 'sjis', 'cp932', 'windows-31j', 'ms932', 'x-sjis'].includes(c)) return 'shift_jis';
  if (c === 'utf8') return 'utf-8';
  return c;
}

function sniffCharset(bytes: Uint8Array): string | undefined {
  // ASCII 部分だけ見れば十分なので latin1 で先頭を読む
  const head = decoder('latin1').decode(bytes.subarray(0, 1024));
  const m = /^\s*charset\s*,\s*([\w-]+)/im.exec(head);
  return m ? m[1] : undefined;
}

function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): string | undefined {
  try {
    return decoder(normalizeCharset(label), fatal).decode(bytes);
  } catch {
    // 未知のラベル、または (fatal のとき) その文字コードとして不正なバイト列
    return undefined;
  }
}

/**
 * 伺か系テキストファイルを文字列にする。
 * BOM → 呼び出し側の指定 (その文字コードとして正しく読めるときだけ) → ファイル内の charset 行
 * → UTF-8 (厳密) → Shift_JIS の順で判定する。
 */
export function decodeText(bytes: Uint8Array, charset?: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decoder('utf-8').decode(bytes.subarray(3));
  }
  if (charset) {
    const text = tryDecode(bytes, charset, true);
    if (text !== undefined) return text;
  }
  const declared = sniffCharset(bytes);
  if (declared) {
    const text = tryDecode(bytes, declared, false);
    if (text !== undefined) return text;
  }
  return tryDecode(bytes, 'utf-8', true) ?? decoder('shift_jis').decode(bytes);
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
