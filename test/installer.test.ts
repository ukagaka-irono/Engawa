import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '../src/vfs/files';
import type { PackageMeta, Refresh } from '../src/vfs/storage';

// IndexedDB を使わず、書き込みを記録するだけの storage
const db = vi.hoisted(() => ({
  metas: new Map<string, PackageMeta>(),
  puts: [] as { meta: PackageMeta; paths: string[]; prefix: string; refresh?: Refresh }[],
}));
vi.mock('../src/vfs/storage', () => ({
  getPackage: async (key: string) => db.metas.get(key),
  putPackage: async (meta: PackageMeta, files: FileTree, prefix = '', refresh?: Refresh) => {
    db.metas.set(meta.key, meta);
    db.puts.push({ meta, paths: [...files.entries()].map(([p]) => prefix + p).sort(), prefix, refresh });
  },
}));

const { installFiles, InstallError } = await import('../src/package/installer');

const enc = (s: string) => new TextEncoder().encode(s);
function tree(files: Record<string, string>): FileTree {
  return new FileTree(Object.entries(files).map(([p, t]) => [p, enc(t)]));
}

const ghost = (key: string, sakuraName: string, acceptNames?: string[]) => ({ key, sakuraName, acceptNames });

beforeEach(() => {
  db.metas.clear();
  db.puts.length = 0;
  for (const key of ['ghost/a', 'ghost/a2', 'ghost/b']) {
    db.metas.set(key, { key, kind: 'ghost', dir: key.slice(6), name: key, installedAt: 0 });
  }
});

describe('installFiles', () => {
  it('installs a shell into the focused ghost when several ghosts match accept', async () => {
    const r = await installFiles(
      tree({ 'install.txt': 'type,shell\r\ndirectory,night\r\naccept,エミリ', 'descript.txt': 'name,夜', 'surfaces.txt': '' }),
      'night.nar',
      async () => [ghost('ghost/a', 'エミリ'), ghost('ghost/a2', 'エミリ')],
      'ghost/a2',
    );
    expect(r).toMatchObject({ type: 'shell', key: 'ghost/a2', rerouted: false, name: '夜' });
    expect(db.puts.at(-1)!.prefix).toBe('shell/night/');
  });

  it('honours install.accept aliases and reports a reroute to another ghost', async () => {
    const r = await installFiles(
      tree({ 'install.txt': 'type,shell\r\ndirectory,x\r\naccept,別名', 'surfaces.txt': '' }),
      'x.nar',
      async () => [ghost('ghost/a', 'A'), ghost('ghost/b', 'B', ['別名'])],
      'ghost/a',
    );
    expect(r).toMatchObject({ key: 'ghost/b', rerouted: true, accept: '別名' });
  });

  it('does not put a shell without accept into another ghost when the focused one is missing from the targets', async () => {
    const run = installFiles(
      tree({ 'install.txt': 'type,shell\r\ndirectory,night', 'surfaces.txt': '' }),
      'night.nar',
      async () => [ghost('ghost/b', 'B')],
      'ghost/a',
    );
    await expect(run).rejects.toMatchObject({ reason: 'unsupported', message: 'インストール先のゴーストが見つかりません' });
    expect(db.puts).toEqual([]);
  });

  it('puts a shell without accept into the only ghost when nothing is focused', async () => {
    const r = await installFiles(tree({ 'install.txt': 'type,shell\r\ndirectory,night', 'surfaces.txt': '' }), 'night.nar', async () => [
      ghost('ghost/b', 'B'),
    ]);
    expect(r).toMatchObject({ key: 'ghost/b', rerouted: false });
  });

  it('refuses a shell addressed to a ghost that is not installed, with the OnInstallRefuse details', async () => {
    const run = installFiles(
      tree({ 'install.txt': 'type,shell\r\naccept,だれか\r\nname,夜シェル', 'descript.txt': 'name,夜', 'surfaces.txt': '' }),
      'x.nar',
      async () => [ghost('ghost/a', 'A')],
    );
    await expect(run).rejects.toBeInstanceOf(InstallError);
    await expect(run).rejects.toMatchObject({ refusal: { accept: 'だれか', type: 'shell', name: '夜シェル' } });
  });

  it('leaves sakuraName empty on a diff update of a ghost that never had one, so it is looked up later', async () => {
    const r = await installFiles(tree({ 'install.txt': 'type,ghost\r\ndirectory,a', 'ghost/master/dic.txt': '' }), 'patch.nar');
    expect(r.key).toBe('ghost/a');
    expect(db.metas.get('ghost/a')!.sakuraName).toBeUndefined();
  });

  it('installs numbered bundled balloons in order and links the first one', async () => {
    const r = await installFiles(
      tree({
        'install.txt': 'type,ghost\r\ndirectory,g\r\nballoon0.directory,b0\r\nballoon0.source.directory,bal/zero\r\nballoon1.directory,b1\r\nballoon1.source.directory,bal/one',
        'ghost/master/descript.txt': 'name,G\r\nsakura.name,さくら\r\ninstall.accept,さく,サクラ',
        'bal/zero/descript.txt': 'name,ゼロ',
        'bal/one/descript.txt': 'name,イチ',
      }),
      'g.nar',
    );
    expect(r.balloons).toEqual([
      { key: 'balloon/b0', name: 'ゼロ' },
      { key: 'balloon/b1', name: 'イチ' },
    ]);
    const meta = db.metas.get('ghost/g')!;
    expect(meta).toMatchObject({ defaultBalloon: 'balloon/b0', sakuraName: 'さくら', acceptNames: ['さく', 'サクラ'] });
    // 同梱バルーンのファイルはゴースト側に残さない
    expect(db.puts.at(-1)!.paths).toEqual(['ghost/master/descript.txt']);
  });

  it('treats an empty balloon.source.directory as the directory name', async () => {
    await installFiles(
      tree({
        'install.txt': 'type,ghost\r\ndirectory,g\r\nballoon.directory,bb\r\nballoon.source.directory,',
        'ghost/master/descript.txt': 'name,G',
        'bb/descript.txt': 'name,B',
      }),
      'g.nar',
    );
    const balloon = db.puts.find((p) => p.meta.key === 'balloon/bb')!;
    expect(balloon.paths).toEqual(['descript.txt']);
    expect(db.puts.find((p) => p.meta.key === 'ghost/g')!.paths).toEqual(['ghost/master/descript.txt']);
  });

  it('passes refresh and its undelete mask to storage', async () => {
    await installFiles(
      tree({ 'install.txt': 'type,ghost\r\ndirectory,g\r\nrefresh,1\r\nrefreshundeletemask,save.json:profile.dat', 'ghost/master/descript.txt': 'name,G' }),
      'g.nar',
    );
    expect(db.puts.at(-1)!.refresh).toEqual({ prefix: '', keep: ['save.json', 'profile.dat'] });
  });

  it('keeps the previous name and bundled balloon on a diff update without descript.txt', async () => {
    db.metas.set('ghost/g', { key: 'ghost/g', kind: 'ghost', dir: 'g', name: 'エミリ', installedAt: 0, sakuraName: 'エミリ', defaultBalloon: 'balloon/x' });
    const r = await installFiles(tree({ 'install.txt': 'type,ghost\r\ndirectory,g', 'ghost/master/dic.txt': '' }), 'patch.nar');
    expect(r.name).toBe('エミリ');
    expect(db.metas.get('ghost/g')).toMatchObject({ name: 'エミリ', defaultBalloon: 'balloon/x', sakuraName: 'エミリ' });
  });

  it('rejects unknown and unsupported types instead of guessing from the contents', async () => {
    const files = { 'ghost/master/descript.txt': 'name,G' };
    await expect(installFiles(tree({ 'install.txt': 'type,plugin', ...files }), 'p.nar')).rejects.toMatchObject({ reason: 'unsupported' });
    await expect(installFiles(tree({ 'install.txt': 'type,mystery', ...files }), 'p.nar')).rejects.toMatchObject({ reason: 'invalid type' });
  });

  it('installs a supplement into the accepting ghost at its root', async () => {
    const r = await installFiles(
      tree({ 'install.txt': 'type,supplement\r\naccept,B\r\nname,追加辞書', 'ghost/master/dic_new.txt': '' }),
      'sup.nar',
      async () => [ghost('ghost/a', 'A'), ghost('ghost/b', 'B')],
      'ghost/b',
    );
    expect(r).toMatchObject({ type: 'supplement', key: 'ghost/b', installName: '追加辞書' });
    expect(db.puts.at(-1)!).toMatchObject({ prefix: '', paths: ['ghost/master/dic_new.txt'] });
  });
});
