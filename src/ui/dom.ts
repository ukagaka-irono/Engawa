/** 画面部品 (メニュー・ダイアログ・通知) で共有する DOM の小道具。 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

let idSeq = 0;

/** aria-labelledby などで要素を結ぶための ID */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++idSeq}`;
}

let tokenRoot: Element | undefined;

/** トークンを読む要素 (既定は :root)。よそのページに埋め込むときは、トークンを持つ Engawa の入れ物にする */
export function setTokenRoot(root: Element): void {
  tokenRoot = root;
}

/** styles.css の :root にある長さのトークン (px) を数値で読む。JS で位置を計算するとき用。 */
export function tokenPx(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(tokenRoot ?? document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}
