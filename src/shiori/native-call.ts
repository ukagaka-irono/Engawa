import type { EmscriptenFS, EmscriptenModule } from './native-engines';

/**
 * WebAssembly にした DLL (SHIORI・SAORI) の load / request を、DLL と同じやり方で呼ぶ。
 * 渡すバイト列は DLL のメモリに malloc で置き (GlobalAlloc に当たる)、解放は DLL 側 (GlobalFree = free) に任せる。
 */

export function mkdirs(fs: EmscriptenFS, dir: string): void {
  let path = '';
  for (const part of dir.split('/').filter(Boolean)) {
    path += '/' + part;
    if (!fs.analyzePath(path).exists) fs.mkdir(path);
  }
}

/** (root からの相対パス, 中身) をメモリ上のファイルシステムに置く */
export function writeFiles(fs: EmscriptenFS, root: string, files: Iterable<[string, Uint8Array]>): void {
  mkdirs(fs, root);
  for (const [path, data] of files) {
    const slash = path.lastIndexOf('/');
    if (slash >= 0) mkdirs(fs, `${root}/${path.slice(0, slash)}`);
    fs.writeFile(`${root}/${path}`, data);
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
