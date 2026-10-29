import { decodeText } from '../util/text';

/**
 * パスを正規化する。区切りは `/`、大文字小文字は区別しない (Windows 由来のゴーストに合わせる)。
 * macOS で作られたアーカイブやフォルダは濁点が分解された形 (NFD) のことがあるので NFC に揃える。
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/').normalize('NFC').toLowerCase();
}

export function joinPath(...paths: string[]): string {
  return normalizePath(paths.filter((p) => p !== '').join('/'));
}

export function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalizePath(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

/** パッケージ1つ分のファイル群。パスは正規化して保持する。 */
export class FileTree {
  private readonly files = new Map<string, Uint8Array>();

  constructor(entries?: Iterable<[string, Uint8Array]>) {
    if (entries) for (const [path, data] of entries) this.set(path, data);
  }

  get size(): number {
    return this.files.size;
  }

  get(path: string): Uint8Array | undefined {
    return this.files.get(normalizePath(path));
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  set(path: string, data: Uint8Array): void {
    const p = normalizePath(path);
    if (p) this.files.set(p, data);
  }

  delete(path: string): void {
    this.files.delete(normalizePath(path));
  }

  text(path: string, charset?: string): string | undefined {
    const data = this.get(path);
    return data ? decodeText(data, charset) : undefined;
  }

  /** prefix ディレクトリ直下以下のパス一覧 (prefix を含んだまま)。 */
  list(prefix = ''): string[] {
    const p = normalizePath(prefix);
    const head = p ? p + '/' : '';
    return [...this.files.keys()].filter((k) => k.startsWith(head));
  }

  /** prefix 直下のサブディレクトリ名一覧。 */
  dirs(prefix = ''): string[] {
    const p = normalizePath(prefix);
    const head = p ? p + '/' : '';
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(head)) continue;
      const rest = k.slice(head.length);
      const i = rest.indexOf('/');
      if (i > 0) out.add(rest.slice(0, i));
    }
    return [...out].sort();
  }

  /** prefix 以下を prefix を取り除いた新しいツリーとして返す。データは共有する。 */
  sub(prefix: string): FileTree {
    const p = normalizePath(prefix);
    if (!p) return new FileTree(this.entries());
    const head = p + '/';
    const out = new FileTree();
    for (const [k, v] of this.files) if (k.startsWith(head)) out.set(k.slice(head.length), v);
    return out;
  }

  entries(): IterableIterator<[string, Uint8Array]> {
    return this.files.entries();
  }
}
