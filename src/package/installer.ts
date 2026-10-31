import { Descript } from './descript';
import { FileTree, normalizePath } from '../vfs/files';
import { decodeText } from '../util/text';
import { deletePackageFiles, getPackage, putPackage, readPackageFile, type PackageKind, type PackageMeta, type Refresh } from '../vfs/storage';

/**
 * インストールの種類。plugin・headline・calendar skin・calendar plugin・language は、Engawa では動かせないが
 * SSP と同じく保存しておく (ゴーストからは一覧やプロパティで見える)。package は複数をまとめたもの
 */
export type InstallType = 'ghost' | 'balloon' | 'shell' | 'supplement' | 'plugin' | 'headline' | 'calendar skin' | 'calendar plugin' | 'language' | 'package';

/** 保存するだけの種類 (パッケージのキーは `種類/ディレクトリ`) */
const STORED_TYPES: InstallType[] = ['plugin', 'headline', 'calendar skin', 'calendar plugin', 'language'];

/** インストールしたもの1つ (OnInstallCompleteEx の識別子・名前・場所) */
export interface Installed {
  type: InstallType;
  name: string;
  /** パッケージのキー */
  key: string;
}

/** OnInstallFailure の Reference0 に使う理由 (ukadoc) */
export type InstallFailure = 'extraction' | 'invalid type' | 'unsupported';

export interface InstallResult {
  type: InstallType;
  /** 表示名 (descript.txt の name) */
  name: string;
  /** install.txt の name (OnInstallComplete の Reference1)。無ければ表示名 */
  installName: string;
  /** ghost / balloon はそのパッケージ、shell / supplement はインストール先ゴーストのキー */
  key: string;
  /** 一緒にインストールしたバルーン (先頭がゴーストやシェルに紐づくもの) */
  balloons: { key: string; name: string }[];
  /** accept で別のゴースト宛てだったので、そちらへ入れた */
  rerouted: boolean;
  accept?: string;
  /** 一緒に入れたものすべて (同梱のバルーン・プラグインなど、package の中身を含む) */
  installed: Installed[];
}

export interface InstallTarget {
  key: string;
  sakuraName: string;
  /** ゴーストの descript.txt の install.accept (別名で受け取る) */
  acceptNames?: string[];
}

/** accept が、インストールされていないゴーストを指名していた (OnInstallRefuse の Reference0〜2) */
export interface Refusal {
  accept: string;
  type: InstallType;
  name: string;
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly reason: InstallFailure,
    readonly refusal?: Refusal,
  ) {
    super(message);
  }
}

/** ゴーストの descript.txt から accept に使う名前 (本体側の名前と install.accept) を取り出す */
export function acceptNamesOf(descript: Descript): string[] {
  return descript
    .str('install.accept')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectType(files: FileTree, install: Descript): InstallType | undefined {
  const t = install.str('type').trim().toLowerCase().replace(/\./g, ' ');
  if (t) {
    if (t.startsWith('ghost')) return 'ghost';
    if (t === 'balloon' || t === 'shell' || t === 'supplement' || t === 'package' || (STORED_TYPES as string[]).includes(t)) return t as InstallType;
    throw new InstallError(`install.txt の type「${t}」が分かりません`, 'invalid type');
  }
  if (files.has('ghost/master/descript.txt')) return 'ghost';
  if (Descript.read(files, 'descript.txt').str('type').toLowerCase() === 'balloon' || files.has('balloons0.png')) {
    return 'balloon';
  }
  if (files.has('surfaces.txt') || files.has('surface0.png')) return 'shell';
  return undefined;
}

/** install.txt やゴースト構造が見つかる位置を探す。zip の中で1階層包まれていることがあるため。 */
function findRoot(files: FileTree): FileTree {
  // 一番上に type 付きの install.txt があれば、それがすべて
  if (Descript.read(files, 'install.txt').str('type')) return files;
  if (detectType(files, new Descript())) return files;
  for (const dir of files.dirs()) {
    const sub = files.sub(dir);
    const install = Descript.read(sub, 'install.txt');
    if (install.str('type') || detectType(sub, new Descript())) return sub;
  }
  return files;
}

function safeDir(name: string): string {
  return normalizePath(name).replace(/[/]/g, '_') || 'unnamed';
}

function withoutInstallTxt(files: FileTree): FileTree {
  const out = new FileTree(files.entries());
  out.delete('install.txt');
  return out;
}

/** install.txt の refresh / refreshundeletemask (接頭辞付きの balloon.refresh なども) */
function refreshOf(install: Descript, prefix: string, keyPrefix = ''): Refresh | undefined {
  if (install.num(`${keyPrefix}refresh`) !== 1) return undefined;
  const keep = install
    .str(`${keyPrefix}refreshundeletemask`)
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  return { prefix, keep };
}

/** delete.txt (消すファイルの一覧。ゴーストのホームからの \\ 区切りの相対パス、末尾が \\ ならディレクトリ) */
export function parseDeleteList(data: Uint8Array): string[] {
  return decodeText(data)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^charset,/i.test(l) && !l.startsWith('//') && !/(^|[\\/])\.\.([\\/]|$)/.test(l));
}

/** パッケージに入れた後で delete.txt のファイルを消す (新しいアーカイブにあればそれ、無ければ保存してあるもの) */
async function applyDeleteList(key: string, files: FileTree, prefix = ''): Promise<void> {
  const data = files.get('delete.txt') ?? (await readPackageFile(key, `${prefix}delete.txt`));
  if (!data) return;
  // 新しく入れたファイルは消さない (フォルダが書かれていても、その中の新しいファイルは残す)
  await deletePackageFiles(
    key,
    parseDeleteList(data).map((p) => `${prefix}${p}`),
    files.list().map((p) => `${prefix}${p}`),
  );
}

/** 同梱できる種類 (install.txt の「種類.directory」の種類と、保存するパッケージの種類) */
const BUNDLE_KINDS: [string, PackageKind][] = [
  ['balloon', 'balloon'],
  ['headline', 'headline'],
  ['plugin', 'plugin'],
  ['calendar.skin', 'calendar skin'],
  ['calendar.plugin', 'calendar plugin'],
];

/**
 * 同梱のもの (balloon.directory → balloon0.directory → balloon1… の順。番号が欠けたら終わり。headline・plugin なども同じ) を
 * それぞれ別のパッケージとして入れ、元のファイル群からは取り除く。
 */
async function installBundled(files: FileTree, install: Descript, rest: FileTree, now: number): Promise<Installed[]> {
  const out: Installed[] = [];
  for (const [entry, kind] of BUNDLE_KINDS) {
    const bases = [entry];
    for (let n = 0; install.get(`${entry}${n}.directory`) !== undefined; n++) bases.push(`${entry}${n}`);
    for (const base of bases) {
      const dir = install.get(`${base}.directory`);
      if (!dir) continue;
      // 空の source.directory はディレクトリ名と同じ扱い (アーカイブ全体を同梱物にしない)
      const source = install.get(`${base}.source.directory`) || dir;
      if (!normalizePath(source)) continue;
      const sub = files.sub(source);
      if (sub.size === 0) continue;
      const bdir = safeDir(dir);
      const key = `${kind}/${bdir}`;
      const prev = await getPackage(key);
      const name = Descript.read(sub, 'descript.txt').str('name', prev?.name ?? bdir);
      await putPackage({ key, kind, dir: bdir, name, installedAt: now }, sub, '', refreshOf(install, '', `${base}.`));
      for (const p of rest.list(source)) rest.delete(p);
      out.push({ type: kind as InstallType, key, name });
    }
  }
  return out;
}

/** 同梱のもののうちバルーン */
const balloonsOf = (items: Installed[]) => items.filter((i) => i.type === 'balloon').map(({ key, name }) => ({ key, name }));

/** accept (本体側の名前) でインストール先を決める。無ければ選択中のゴースト */
function pickTarget(targets: InstallTarget[], accept: string, preferred: string | undefined, item: { type: InstallType; name: string }): InstallTarget {
  if (accept) {
    // 同じ本体側の名前のゴーストが複数あれば、選択中のゴーストを優先する
    const hits = targets.filter((t) => t.sakuraName === accept || t.acceptNames?.includes(accept));
    const target = hits.find((t) => t.key === preferred) ?? hits[0];
    if (!target) {
      throw new InstallError(`「${accept}」宛てですが、そのゴーストがインストールされていません`, 'unsupported', { accept, ...item });
    }
    return target;
  }
  // accept が無ければ選択中のゴーストへ。選択中のゴーストがあるのに宛先に無いときは、別のゴーストに入れない
  const target = preferred !== undefined ? targets.find((t) => t.key === preferred) : targets[0];
  if (!target) {
    throw new InstallError(preferred !== undefined ? MISSING_TARGET : 'インストール先になるゴーストがありません', 'unsupported');
  }
  return target;
}

/** 選んだインストール先のゴーストが (別のタブで削除されたなどで) 見つからない */
const MISSING_TARGET = 'インストール先のゴーストが見つかりません';

/**
 * 展開済みのアーカイブをインストールする。
 * @param fallbackName install.txt に directory が無いときのディレクトリ名 (ファイル名やフォルダ名)
 * @param targets シェル・追加ファイルのインストール先候補 (インストール済みのゴースト全部)
 * @param preferred accept が無いときに使うゴースト (選択中のゴースト)
 */
export async function installFiles(
  input: FileTree,
  fallbackName: string,
  targets: () => Promise<InstallTarget[]> = async () => [],
  preferred?: string,
): Promise<InstallResult> {
  const files = findRoot(input);
  const install = Descript.read(files, 'install.txt');
  const type = detectType(files, install);
  if (!type) throw new InstallError('ゴースト・シェル・バルーンのいずれとしても認識できませんでした', 'invalid type');
  const dir = safeDir(install.str('directory') || fallbackName.replace(/\.(nar|zip)$/i, ''));
  const now = Date.now();
  const rest = withoutInstallTxt(files);
  const accept = install.str('accept');

  if (type === 'package') {
    // 複数をまとめたもの。中のディレクトリをそれぞれ入れ、最初のゴースト (無ければ最初のもの) を結果にする
    const results: InstallResult[] = [];
    for (const sub of files.dirs()) {
      const part = files.sub(sub);
      if (!part.has('install.txt') && !detectType(part, new Descript())) continue;
      results.push(await installFiles(part, sub, targets, preferred));
    }
    if (!results.length) throw new InstallError('パッケージの中にインストールできるものがありません', 'invalid type');
    const main = results.find((r) => r.type === 'ghost') ?? results[0];
    const name = install.str('name', main.name);
    return { ...main, type: 'package', name, installName: name, installed: results.flatMap((r) => r.installed) };
  }

  if (type === 'balloon' || (STORED_TYPES as string[]).includes(type)) {
    const kind = type as PackageKind;
    const key = `${kind}/${dir}`;
    const prev = await getPackage(key);
    const name = Descript.read(files, 'descript.txt').str('name', install.str('name', prev?.name ?? dir));
    await putPackage({ key, kind, dir, name, installedAt: now }, rest, '', refreshOf(install, ''));
    await applyDeleteList(key, rest);
    return { type, name, installName: install.str('name', name), key, balloons: [], rerouted: false, installed: [{ type, name, key }] };
  }

  if (type === 'shell' || type === 'supplement') {
    const name = type === 'shell' ? Descript.read(files, 'descript.txt').str('name', dir) : install.str('name', dir);
    const target = pickTarget(await targets(), accept, preferred, { type, name: install.str('name', name) });
    const existing = await getPackage(target.key);
    if (!existing) throw new InstallError(MISSING_TARGET, 'unsupported');
    const bundled = await installBundled(files, install, rest, now);
    const prefix = type === 'shell' ? `shell/${dir}/` : '';
    await putPackage(existing, rest, prefix, refreshOf(install, type === 'shell' ? `shell/${dir}` : ''));
    await applyDeleteList(target.key, rest, prefix);
    return {
      type,
      name,
      installName: install.str('name', name),
      key: target.key,
      balloons: balloonsOf(bundled),
      rerouted: !!preferred && target.key !== preferred,
      accept: accept || undefined,
      installed: [{ type, name, key: target.key }, ...bundled],
    };
  }

  // ghost
  const key = `ghost/${dir}`;
  const prev = await getPackage(key);
  const bundled = await installBundled(files, install, rest, now);
  const balloons = balloonsOf(bundled);
  const descript = files.has('ghost/master/descript.txt') ? Descript.read(files, 'ghost/master/descript.txt') : undefined;
  // 差分 nar (descript.txt を含まない) でも、前の名前や同梱バルーンを引き継ぐ
  const name = descript?.str('name') || prev?.name || dir;
  const meta: PackageMeta = {
    key,
    kind: 'ghost',
    dir,
    name,
    installedAt: now,
    // descript.txt を含まない差分で、前の情報も無いときは空のままにし、宛先を調べるときに読み直す
    sakuraName: descript ? descript.str('sakura.name', name) : prev?.sakuraName,
    acceptNames: descript ? acceptNamesOf(descript) : prev?.acceptNames,
    defaultBalloon: balloons[0]?.key ?? prev?.defaultBalloon,
  };
  await putPackage(meta, rest, '', refreshOf(install, ''));
  await applyDeleteList(key, rest);
  return { type, name, installName: install.str('name', name), key, balloons, rerouted: false, installed: [{ type, name, key }, ...bundled] };
}
