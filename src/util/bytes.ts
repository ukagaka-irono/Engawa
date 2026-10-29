/** バイト列に、文字列 (UTF-8) がそのまま含まれるか。DLL の中身で SHIORI・SAORI を見分けるのに使う */
export function containsText(data: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  const first = needle[0];
  outer: for (let i = data.indexOf(first); i >= 0 && i <= data.length - needle.length; i = data.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
