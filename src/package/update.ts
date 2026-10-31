import { md5 } from '../util/md5';
import { decodeText } from '../util/text';
import type { FileTree } from '../vfs/files';
import { parseDeleteList } from './installer';

/**
 * ネットワーク更新 (ukadoc の「ネットワーク更新」「updates2.dau/updates.txt」)。
 * homeurl の updates2.dau (無ければ updates.txt) を取り、MD5 が違うファイルだけを取り直す。
 * ブラウザの fetch で取るので、配布先のサーバーが CORS を許していないと失敗する (理由は fetch)。
 */

export interface UpdateEntry {
  path: string;
  md5: string;
}

/** updates2.dau / updates.txt を読む。危ないパス (.. やディレクトリ) と MD5 の無い行は除く */
export function parseUpdateList(data: Uint8Array): UpdateEntry[] {
  // charset は先頭の行の charset= か、updates.txt の charset 行。読めなければ UTF-8 → Shift_JIS の順に試す
  const head = new TextDecoder('latin1').decode(data.subarray(0, 4096));
  const charset = /charset[=,]\s*([\w-]+)/i.exec(head)?.[1];
  const text = decodeText(data, charset);
  const entries: UpdateEntry[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw;
    if (/^charset,/i.test(line)) continue;
    if (/^file,/i.test(line)) line = line.slice(5);
    const fields = line.split('\x01');
    let path = fields[0]?.trim().replace(/\\/g, '/');
    const hash = fields[1]?.trim().toLowerCase();
    if (!path || !hash || !/^[0-9a-f]{32}$/.test(hash)) continue;
    if (path.endsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) continue;
    if (/%[0-9A-Fa-f]{2}/.test(path)) {
      try {
        path = decodeURIComponent(path);
      } catch {
        // そのまま使う
      }
    }
    entries.push({ path, md5: hash });
  }
  return entries;
}

export interface UpdateHooks {
  /** ゴーストにイベントを送る (返ったスクリプトは再生する) */
  raise(id: string, refs: (string | number)[]): Promise<unknown>;
  /** 取り直したファイルを保存する (パッケージのルートからの相対パス) */
  write(path: string, data: Uint8Array): Promise<void>;
  /** delete.txt に書かれたファイルを消す (末尾が / はディレクトリ) */
  remove?(paths: string[]): Promise<void>;
}

export interface UpdateOptions {
  /** 更新対象種別 (ghost / shell / balloon) */
  target: string;
  /** 更新実行理由 (manual = メニュー、script = スクリプトから) */
  reason: string;
  /** 更新の有無だけを調べる (\![update,…,checkonly]) */
  checkOnly?: boolean;
  /** 取ってくるが置き換えない (testonly) */
  testOnly?: boolean;
  /** 手元の MD5 を見ずにすべて取り直す (recovery) */
  recovery?: boolean;
  /** ゴースト以外 (シェル・バルーン)。イベントの名前が OnUpdateOther… になる */
  other?: boolean;
  ghostName: string;
  path: string;
}

export interface UpdateResult {
  ok: boolean;
  /** 取り直したファイル */
  changed: string[];
  /** 失敗の理由 (timeout・md5 miss・404・fetch など) */
  reason?: string;
  file?: string;
}

/** 更新の取得先。homeurl の末尾に / を足す */
export function updateBase(homeurl: string): string | undefined {
  const url = homeurl.trim();
  if (!/^https?:\/\//i.test(url)) return undefined;
  return url.endsWith('/') ? url : `${url}/`;
}

async function fetchBytes(url: string): Promise<{ data?: Uint8Array; code: string }> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return { code: String(res.status) };
    return { data: new Uint8Array(await res.arrayBuffer()), code: '200' };
  } catch {
    return { code: 'fetch' };
  }
}

/** パスの各部分を URL 用にエンコードする */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

export async function networkUpdate(homeurl: string, files: FileTree, hooks: UpdateHooks, opts: UpdateOptions): Promise<UpdateResult> {
  const { target, reason } = opts;
  // シェル・バルーンの更新は OnUpdateOther… (ukadoc の「ネットワーク更新イベント」)
  const ev = opts.other ? 'OnUpdateOther' : 'OnUpdate';
  const fail = async (why: string, file = ''): Promise<UpdateResult> => {
    if (opts.checkOnly) await hooks.raise('OnUpdateCheckFailure', [why, '', '', '', reason]);
    else await hooks.raise(`${ev}Failure`, [why, file, '', target, reason]);
    return { ok: false, changed: [], reason: why, file };
  };
  const base = updateBase(homeurl);
  if (!opts.checkOnly) await hooks.raise(`${ev}Begin`, [opts.ghostName, opts.path, '', target, reason]);
  if (!base) return fail('404');
  let list = await fetchBytes(`${base}updates2.dau`);
  if (!list.data) list = await fetchBytes(`${base}updates.txt`);
  if (!list.data) return fail(list.code);
  const entries = parseUpdateList(list.data);
  const changed = entries.filter((e) => {
    if (opts.recovery) return true;
    const local = files.get(e.path);
    return !local || md5(local) !== e.md5;
  });
  const names = changed.map((e) => e.path).join(',');
  if (opts.checkOnly) {
    await hooks.raise('OnUpdateCheckComplete', [changed.length ? changed.length : 'none', names, '', target, reason]);
    return { ok: true, changed: changed.map((e) => e.path) };
  }
  if (!changed.length) {
    await removeListed(files, hooks);
    await hooks.raise(`${ev}Complete`, ['none', '', '', target, reason]);
    return { ok: true, changed: [] };
  }
  await hooks.raise(`${ev}Ready`, [changed.length - 1, names, '', target, reason]);
  const done: string[] = [];
  for (let i = 0; i < changed.length; i++) {
    const e = changed[i];
    await hooks.raise(`${ev}.OnDownloadBegin`, [e.path, i, changed.length - 1, target, reason]);
    const got = await fetchBytes(`${base}${encodePath(e.path)}`);
    if (!got.data) return fail(got.code, e.path);
    const hash = md5(got.data);
    await hooks.raise(`${ev}.OnMD5CompareBegin`, [e.path, e.md5, hash, target, reason]);
    if (hash !== e.md5) {
      await hooks.raise(`${ev}.OnMD5CompareFailure`, [e.path, e.md5, hash, target, reason]);
      return fail('md5 miss', e.path);
    }
    await hooks.raise(`${ev}.OnMD5CompareComplete`, [e.path, e.md5, hash, target, reason]);
    if (!opts.testOnly) {
      await hooks.write(e.path, got.data);
      files.set(e.path, got.data);
    }
    done.push(e.path);
  }
  if (!opts.testOnly) await removeListed(files, hooks);
  await hooks.raise(`${ev}Complete`, ['changed', done.join(','), '', target, reason]);
  return { ok: true, changed: done };
}

/** delete.txt に書かれたファイルを消す (更新で一度配ったファイルを取り除くためのもの) */
async function removeListed(files: FileTree, hooks: UpdateHooks): Promise<void> {
  const list = files.get('delete.txt');
  if (!list || !hooks.remove) return;
  const paths = parseDeleteList(list).map((p) => p.replace(/\\/g, '/'));
  if (!paths.length) return;
  await hooks.remove(paths);
  for (const p of paths) {
    if (p.endsWith('/')) for (const f of files.list(p.slice(0, -1))) files.delete(f);
    else files.delete(p);
  }
}

/** 更新の結果1つ (OnUpdateResult・OnUpdateResultEx の Reference) */
export interface UpdateSummary {
  name: string;
  target: string;
  result: UpdateResult;
}

/** OnUpdateResult の Reference (種別\1OK・NG\1数か理由\1ファイル) と OnUpdateResultEx (名前\1種別\1…) */
export function updateResultRefs(list: UpdateSummary[], ex: boolean): string[] {
  return list.map(({ name, target, result }) => {
    const fields = [target, result.ok ? 'OK' : 'NG', result.ok ? String(result.changed.length) : (result.reason ?? '')];
    if (!result.ok && result.file) fields.push(result.file);
    return (ex ? [name, ...fields] : fields).join('\x01');
  });
}
