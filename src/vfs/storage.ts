import { FileTree, basename, normalizePath } from './files';

export type PackageKind = 'ghost' | 'balloon';

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

export function listPackages(): Promise<PackageMeta[]> {
  return run(['packages'], 'readonly', (tx) => result(tx.objectStore('packages').getAll() as IDBRequest<PackageMeta[]>));
}

export function getPackage(key: string): Promise<PackageMeta | undefined> {
  return run(['packages'], 'readonly', (tx) => result(tx.objectStore('packages').get(key) as IDBRequest<PackageMeta | undefined>));
}

/**
 * パッケージを書き込む。既存のファイルは消さずに上書きする (更新時にセーブデータを残すため)。
 * refresh があれば、その範囲の既存ファイルを先に消す (同じトランザクション内なので途中で失敗しても元のまま)。
 */
export function putPackage(meta: PackageMeta, files: FileTree, prefix = '', refresh?: Refresh): Promise<void> {
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

export function readPackageFiles(key: string): Promise<FileTree> {
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
export function readPackageFile(key: string, path: string): Promise<Uint8Array | undefined> {
  return run(['files'], 'readonly', (tx) => result(tx.objectStore('files').get([key, normalizePath(path)]) as IDBRequest<Uint8Array | undefined>));
}

/**
 * 保存されているパッケージ情報に patch を書き足す (読み出しと書き込みを1つのトランザクションで)。
 * 別のタブで更新・削除されていても古い内容で上書きしないよう、手元の情報ではなく保存されている方を元にする。
 * パッケージが無ければ何もしないで undefined。keep が真を返す (既に新しい値がそろっている) ときは書かずにそれを返す。
 */
export function patchPackageMeta(
  key: string,
  patch: Partial<PackageMeta>,
  keep: (current: PackageMeta) => boolean = () => false,
): Promise<PackageMeta | undefined> {
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

export function writePackageFile(key: string, path: string, data: Uint8Array): Promise<void> {
  return run(['files'], 'readwrite', async (tx) => {
    tx.objectStore('files').put(data, [key, normalizePath(path)]);
  });
}

export function deletePackage(key: string): Promise<void> {
  return run(['packages', 'files'], 'readwrite', async (tx) => {
    tx.objectStore('packages').delete(key);
    tx.objectStore('files').delete(packageRange(key));
  });
}
