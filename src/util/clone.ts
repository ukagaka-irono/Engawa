/** JSON にできる値 (設定やパッケージ情報) の深いコピー。structuredClone の無いブラウザ (Safari 15.3 以前) 向け */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
