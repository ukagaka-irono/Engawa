/** バイト列に、文字列 (UTF-8) がそのまま含まれるか。DLL の中身で SHIORI・SAORI を見分けるのに使う */
export function containsText(data: Uint8Array, text: string): boolean {
  return containsBytes(data, new TextEncoder().encode(text));
}

/** バイト列に、文字列が UTF-16LE (Windows のワイド文字列) で含まれるか。Unicode 版の DLL は文字列をこの形で持つ */
export function containsWideText(data: Uint8Array, text: string): boolean {
  const needle = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    needle[i * 2] = text.charCodeAt(i) & 0xff;
    needle[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return containsBytes(data, needle);
}

function containsBytes(data: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  outer: for (let i = data.indexOf(first); i >= 0 && i <= data.length - needle.length; i = data.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Windows の DLL のファイルバージョン (リソースの VS_VERSION_INFO にある VS_FIXEDFILEINFO の dwFileVersionMS・LS)。
 * 印 0xFEEF04BD は 4 バイト境界に置かれる。無ければ undefined
 */
export function dllFileVersion(data: Uint8Array): [number, number, number, number] | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = data.indexOf(0xbd); i >= 0 && i + 16 <= data.length; i = data.indexOf(0xbd, i + 1)) {
    if (i % 4 !== 0 || view.getUint32(i, true) !== 0xfeef04bd) continue;
    // 次の dwStrucVersion は 0x00010000
    if (view.getUint32(i + 4, true) !== 0x10000) continue;
    const ms = view.getUint32(i + 8, true);
    const ls = view.getUint32(i + 12, true);
    return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  }
  return undefined;
}
