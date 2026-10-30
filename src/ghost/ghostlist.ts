/**
 * プロパティシステムの ghostlist・activeghostlist (ukadoc の list/propertysystem)。
 *   ghostlist(ゴースト名/本体側名/パス).項目   名前・本体側の名前・パスのどれかで探す
 *   ghostlist.index(番号).項目                 リストの番号 (0 から)
 *   ghostlist.current.項目                     いまのゴースト
 * activeghostlist は起動中のゴーストだけのリストで、書き方は同じ。
 */

/** リストの1つ。起動中なら descript があり、相方の名前・作者なども答えられる */
export interface GhostListEntry {
  name: string;
  sakuraName: string;
  path: string;
  keroName?: string;
  descript?: { str(key: string): string };
}

/** ghostlist(…).項目 の値 (汎用プロパティ名のうち、分かるもの) */
function field(e: GhostListEntry, index: number, name: string): string {
  switch (name) {
    case 'name':
      return e.name;
    case 'sakuraname':
      return e.sakuraName;
    case 'path':
      return e.path;
    case 'index':
      return String(index);
    case 'keroname':
      return e.keroName ?? '';
    case 'craftman':
    case 'craftmanw':
    case 'craftmanurl':
    case 'homeurl':
      return e.descript?.str(name) ?? '';
    default:
      return '';
  }
}

/**
 * p はプロパティ名 (小文字にしたもの)。ghostlist・activeghostlist のものでなければ undefined。
 * 見つからないゴーストや知らない項目は空文字列。
 */
export function ghostListProperty(p: string, installed: GhostListEntry[], active: GhostListEntry[], currentPath: string): string | undefined {
  const m = /^(ghostlist|activeghostlist)(?:\((.*)\)|\.index\((\d+)\)|\.(current))\.(\w+)$/.exec(p);
  if (!m) return undefined;
  const [, list, key, index, current, name] = m;
  const entries = list === 'activeghostlist' ? active : installed;
  const at =
    index !== undefined
      ? Number(index)
      : current
        ? entries.findIndex((e) => e.path === currentPath)
        : entries.findIndex((e) => [e.name, e.sakuraName, e.path].some((v) => v.toLowerCase() === key.trim()));
  const e = entries[at];
  return e ? field(e, at, name) : '';
}
