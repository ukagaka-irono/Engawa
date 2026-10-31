import type { EmscriptenFS, EmscriptenModule } from './native-engines';

/**
 * WebAssembly にした DLL (SHIORI・SAORI) の load / request を、DLL と同じやり方で呼ぶ。
 * 渡すバイト列は DLL のメモリに malloc で置き (GlobalAlloc に当たる)、解放は DLL 側 (GlobalFree = free) に任せる。
 */

export function mkdirs(fs: EmscriptenFS, dir: string): void {
  let path = '';
  for (const part of dir.split('/').filter(Boolean)) {
    path += '/' + part;
    const found = fs.analyzePath(path);
    // 前の版がフォルダの項目を空のファイルとして保存していることがある (区切りが \ の nar)
    if (found.exists && !fs.isDir(fs.stat(path).mode) && fs.stat(path).size === 0) fs.unlink(path);
    else if (found.exists) continue;
    fs.mkdir(path);
  }
}

/**
 * Windows と同じく、root の下ではファイル名の大文字・小文字を区別しないようにする。
 * ゴーストのファイルは小文字で置く (vfs/files.ts の normalizePath と同じ) ので、見つからない名前は小文字にして探し直し、
 * root の下に作るファイルも小文字の名前にする (yaya.txt の `dic, dic\module\yaya_iObj.aym` など)
 */
export function ignoreCase(fs: EmscriptenFS, root: string): void {
  const raw = fs as unknown as {
    lookupNode(parent: unknown, name: string): unknown;
    mknod(path: string, mode: number, dev: number): unknown;
    rename(from: string, to: string): void;
    cwd(): string;
  };
  const fold = (name: string) => name.normalize('NFC').toLowerCase();
  const under = (path: string) => (path.startsWith('/') ? path : `${raw.cwd()}/${path}`).startsWith(`${root}/`);
  const foldBase = (path: string) => {
    if (!under(path)) return path;
    const slash = path.lastIndexOf('/');
    return path.slice(0, slash + 1) + fold(path.slice(slash + 1));
  };
  const { lookupNode, mknod, rename } = raw;
  raw.lookupNode = (parent, name) => {
    try {
      return lookupNode.call(fs, parent, name);
    } catch (e) {
      if (fold(name) === name) throw e;
      return lookupNode.call(fs, parent, fold(name));
    }
  };
  raw.mknod = (path, mode, dev) => mknod.call(fs, foldBase(path), mode, dev);
  raw.rename = (from, to) => rename.call(fs, from, foldBase(to));
}

/** (root からの相対パス, 中身) をメモリ上のファイルシステムに置く */
export function writeFiles(fs: EmscriptenFS, root: string, files: Iterable<[string, Uint8Array]>): void {
  mkdirs(fs, root);
  for (const [path, data] of files) {
    try {
      const slash = path.lastIndexOf('/');
      if (slash >= 0) mkdirs(fs, `${root}/${path.slice(0, slash)}`);
      fs.writeFile(`${root}/${path}`, data);
    } catch (e) {
      throw new Error(`${path} を置けません (errno ${(e as { errno?: number }).errno})`);
    }
  }
}

/** dir 以下のファイルを (dir からの相対パス, 絶対パス) で列挙する */
export function* walk(fs: EmscriptenFS, dir: string, rel = ''): Generator<[string, string]> {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    const relPath = rel ? `${rel}/${name}` : name;
    const st = fs.stat(path);
    if (fs.isDir(st.mode)) yield* walk(fs, path, relPath);
    else if (fs.isFile(st.mode)) yield [relPath, path];
  }
}

export function put(m: EmscriptenModule, data: Uint8Array): number {
  const ptr = m._malloc(data.length + 1);
  m.HEAPU8.set(data, ptr);
  m.HEAPU8[ptr + data.length] = 0;
  return ptr;
}

export function callLoad(m: EmscriptenModule, dir: Uint8Array): boolean {
  return !!m._load(put(m, dir), dir.length);
}

/** 答えが無ければ空のバイト列 */
export function callRequest(m: EmscriptenModule, data: Uint8Array): Uint8Array {
  const lenPtr = m._malloc(4);
  try {
    m.HEAP32[lenPtr >> 2] = data.length;
    const res = m._request(put(m, data), lenPtr);
    if (!res) return new Uint8Array(0);
    const len = m.HEAP32[lenPtr >> 2];
    const out = m.HEAPU8.slice(res, res + Math.max(0, len));
    m._free(res);
    return out;
  } finally {
    m._free(lenPtr);
  }
}
