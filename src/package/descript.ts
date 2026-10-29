import type { FileTree } from '../vfs/files';

/** `key,value` 形式の設定ファイル (descript.txt / install.txt)。キーは小文字化して保持する。 */
export class Descript {
  private readonly map = new Map<string, string>();

  static parse(text: string): Descript {
    const d = new Descript();
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const i = line.indexOf(',');
      if (i < 0) continue;
      d.map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    return d;
  }

  static read(files: FileTree, path: string): Descript {
    const text = files.text(path);
    return text === undefined ? new Descript() : Descript.parse(text);
  }

  get(key: string): string | undefined {
    return this.map.get(key.toLowerCase());
  }

  str(key: string, fallback = ''): string {
    return this.get(key) ?? fallback;
  }

  num(key: string, fallback = 0): number {
    const v = this.get(key);
    if (v === undefined) return fallback;
    const n = Number(v.split(',')[0]);
    return Number.isFinite(n) ? n : fallback;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}
