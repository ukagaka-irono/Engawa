import { clone } from '../util/clone';
import { FileTree, basename, normalizePath } from './files';

/** ゴースト・バルーンのほか、Engawa では動かせないが SSP と同じく保存しておくもの (プラグイン・ヘッドラインなど) */
export type PackageKind = 'ghost' | 'balloon' | 'plugin' | 'headline' | 'calendar skin' | 'calendar plugin' | 'language';

export interface PackageMeta {
  /** `ghost/<dir>` や `balloon/<dir>` */
  key: string;
  kind: PackageKind;
  dir: string;
  name: string;
  installedAt: number;
  /** ゴーストの本体側の名前 (sakura.name)。シェルや追加ファイルの accept の照合に使う */
  sakuraName?: string;
  /** descript.txt の install.accept (sakura.name の他に受け取る名前) */
  acceptNames?: string[];
  /** ゴーストと同梱でインストールされたバルーンのキー */
  defaultBalloon?: string;
}

/** install.txt の refresh。prefix 以下を消してから書き込む (mask のファイル名は残す) */
export interface Refresh {
  prefix: string;
  keep: string[];
}

const DB_NAME = 'engawa';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => {
      const db = req.result;
      // 接続が切れたら次の呼び出しで開き直す
      db.onclose = () => {
        if (dbPromise === current) dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        if (dbPromise === current) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (dbPromise === current) dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => console.warn('[storage] 別のタブが古い接続を開いたままです');
  });
  const current = dbPromise;
  return current;
}

/**
 * IndexedDB が使えない場所 (ブラウザによっては file:// で開いたページ、プライベートモード、埋め込みの表示など) では、
 * メモリに置いて動かす。その場合、インストールしたものはページを閉じると消える。
 */
const memory = {
  packages: new Map<string, PackageMeta>(),
  files: new Map<string, Map<string, Uint8Array>>(),
};

function memoryFiles(key: string): Map<string, Uint8Array> {
  let files = memory.files.get(key);
  if (!files) {
    files = new Map();
    memory.files.set(key, files);
  }
  return files;
}

let modePromise: Promise<boolean> | null = null;

/** IndexedDB が使えずメモリで動いているか。一時的な失敗はメモリ扱いにせず、次の呼び出しで試し直す */
function inMemory(): Promise<boolean> {
  modePromise ??= openDB().then(
    () => false,
    (e: unknown) => {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'SecurityError' || name === 'InvalidAccessError' || name === 'ReferenceError' || e instanceof TypeError) {
        console.warn('[storage] IndexedDB が使えないため、メモリに保存します', e);
        return true;
      }
      modePromise = null;
      throw e;
    },
  );
  return modePromise;
}

/** IndexedDB を使わず、メモリだけに置く (よそのページに埋め込んだときのおためし起動など) */
export function useMemoryStorage(): void {
  modePromise = Promise.resolve(true);
}

/** メモリに置いたものを全部消す (おためし起動をやり直すとき) */
export function clearMemoryStorage(): void {
  memory.packages.clear();
  memory.files.clear();
}

/** インストールしたものがページを閉じても残るか */
export async function isPersistent(): Promise<boolean> {
  try {
    return !(await inMemory());
  } catch {
    return false;
  }
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * トランザクションを1つ実行する。接続が切れていた (InvalidStateError / Safari の UnknownError) ときは
 * 一度だけ開き直してやり直す。
 */
async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const db = await openDB();
      const tx = db.transaction(stores, mode);
      const [value] = await Promise.all([body(tx), done(tx)]);
      return value;
    } catch (e) {
      const name = (e as DOMException | null)?.name;
      if (attempt === 0 && (name === 'InvalidStateError' || name === 'UnknownError')) {
        dbPromise = null;
        continue;
      }
      throw e;
    }
  }
}

/** files ストアのキーは [パッケージキー, パス]。配列は文字列より大きいので [key, []] が上限になる。 */
function packageRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key], [key, []]);
}

function prefixRange(key: string, prefix: string): IDBKeyRange {
  return prefix ? IDBKeyRange.bound([key, prefix], [key, prefix + '￿']) : packageRange(key);
}

export async function listPackages(): Promise<PackageMeta[]> {
  if (await inMemory()) return [...memory.packages.values()].map((m) => clone(m));
  return run(['packages'], 'readonly', (tx) => result(tx.objectStore('packages').getAll() as IDBRequest<PackageMeta[]>));
}

export async function getPackage(key: string): Promise<PackageMeta | undefined> {
  if (await inMemory()) {
    const meta = memory.packages.get(key);
    return meta && clone(meta);
  }
  return run(['packages'], 'readonly', (tx) => result(tx.objectStore('packages').get(key) as IDBRequest<PackageMeta | undefined>));
}

/**
 * パッケージを書き込む。既存のファイルは消さずに上書きする (更新時にセーブデータを残すため)。
 * refresh があれば、その範囲の既存ファイルを先に消す (同じトランザクション内なので途中で失敗しても元のまま)。
 */
export async function putPackage(meta: PackageMeta, files: FileTree, prefix = '', refresh?: Refresh): Promise<void> {
  if (await inMemory()) {
    memory.packages.set(meta.key, clone(meta));
    const stored = memoryFiles(meta.key);
    if (refresh) {
      const keep = new Set(refresh.keep.map((n) => normalizePath(n)));
      const head = normalizePath(refresh.prefix) ? normalizePath(refresh.prefix) + '/' : '';
      for (const path of [...stored.keys()]) if (path.startsWith(head) && !keep.has(basename(path))) stored.delete(path);
    }
    for (const [path, data] of files.entries()) stored.set(prefix + path, data);
    return;
  }
  return run(['packages', 'files'], 'readwrite', async (tx) => {
    tx.objectStore('packages').put(meta);
    const store = tx.objectStore('files');
    if (refresh) {
      const keep = new Set(refresh.keep.map((n) => normalizePath(n)));
      const keys = await result(store.getAllKeys(prefixRange(meta.key, normalizePath(refresh.prefix) ? normalizePath(refresh.prefix) + '/' : '')));
      for (const k of keys) {
        const path = (k as [string, string])[1];
        if (!keep.has(basename(path))) store.delete(k);
      }
    }
    for (const [path, data] of files.entries()) store.put(data, [meta.key, prefix + path]);
  });
}

export async function readPackageFiles(key: string): Promise<FileTree> {
  if (await inMemory()) return new FileTree(memoryFiles(key).entries());
  return run(['files'], 'readonly', async (tx) => {
    const store = tx.objectStore('files');
    const range = packageRange(key);
    const [keys, values] = await Promise.all([
      result(store.getAllKeys(range)),
      result(store.getAll(range) as IDBRequest<Uint8Array[]>),
    ]);
    return new FileTree(keys.map((k, i) => [(k as [string, string])[1], values[i]]));
  });
}

/** パッケージ内の1ファイルだけを読む */
export async function readPackageFile(key: string, path: string): Promise<Uint8Array | undefined> {
  if (await inMemory()) return memory.files.get(key)?.get(normalizePath(path));
  return run(['files'], 'readonly', (tx) => result(tx.objectStore('files').get([key, normalizePath(path)]) as IDBRequest<Uint8Array | undefined>));
}

/**
 * 保存されているパッケージ情報に patch を書き足す (読み出しと書き込みを1つのトランザクションで)。
 * 別のタブで更新・削除されていても古い内容で上書きしないよう、手元の情報ではなく保存されている方を元にする。
 * パッケージが無ければ何もしないで undefined。keep が真を返す (既に新しい値がそろっている) ときは書かずにそれを返す。
 */
export async function patchPackageMeta(
  key: string,
  patch: Partial<PackageMeta>,
  keep: (current: PackageMeta) => boolean = () => false,
): Promise<PackageMeta | undefined> {
  if (await inMemory()) {
    const current = memory.packages.get(key);
    if (!current) return undefined;
    if (keep(current)) return clone(current);
    const next = { ...current, ...patch, key };
    memory.packages.set(key, next);
    return clone(next);
  }
  return run(['packages'], 'readwrite', async (tx) => {
    const store = tx.objectStore('packages');
    const current = await result(store.get(key) as IDBRequest<PackageMeta | undefined>);
    if (!current) return undefined;
    if (keep(current)) return current;
    const next = { ...current, ...patch, key };
    store.put(next);
    return next;
  });
}

export async function writePackageFile(key: string, path: string, data: Uint8Array): Promise<void> {
  if (await inMemory()) {
    if (memory.packages.has(key)) memoryFiles(key).set(normalizePath(path), data);
    return;
  }
  return run(['files'], 'readwrite', async (tx) => {
    tx.objectStore('files').put(data, [key, normalizePath(path)]);
  });
}

/** パッケージの中のファイルを消す (delete.txt)。末尾が / のものはそのディレクトリの中をすべて */
export async function deletePackageFiles(key: string, paths: string[], keep: Iterable<string> = []): Promise<void> {
  // keep は消さないもの (同じインストール・更新で入れたファイル。delete.txt にフォルダが書かれていても残す)
  const kept = new Set([...keep].map((p) => normalizePath(p)));
  const exact = new Set<string>();
  const dirs: string[] = [];
  for (const raw of paths) {
    const p = normalizePath(raw.replace(/\\/g, '/'));
    if (!p || kept.has(p)) continue;
    if (/[\\/]$/.test(raw)) dirs.push(`${p}/`);
    else exact.add(p);
  }
  if (!exact.size && !dirs.length) return;
  if (await inMemory()) {
    const stored = memory.files.get(key);
    if (!stored) return;
    for (const path of [...stored.keys()]) if (exact.has(path) || (dirs.some((d) => path.startsWith(d)) && !kept.has(path))) stored.delete(path);
    return;
  }
  return run(['files'], 'readwrite', async (tx) => {
    const store = tx.objectStore('files');
    for (const p of exact) store.delete([key, p]);
    for (const d of dirs) {
      if (!kept.size) {
        store.delete(prefixRange(key, d));
        continue;
      }
      for (const k of await result(store.getAllKeys(prefixRange(key, d)))) if (!kept.has((k as [string, string])[1])) store.delete(k);
    }
  });
}

export async function deletePackage(key: string): Promise<void> {
  if (await inMemory()) {
    memory.packages.delete(key);
    memory.files.delete(key);
    return;
  }
  return run(['packages', 'files'], 'readwrite', async (tx) => {
    tx.objectStore('packages').delete(key);
    tx.objectStore('files').delete(packageRange(key));
  });
}
