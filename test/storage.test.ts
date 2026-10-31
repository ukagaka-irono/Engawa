import { describe, expect, it, vi } from 'vitest';
import { FileTree } from '../src/vfs/files';
import { deletePackageFiles, putPackage, readPackageFiles } from '../src/vfs/storage';

const enc = (s: string) => new TextEncoder().encode(s);

describe('deletePackageFiles (Node では IndexedDB が無いのでメモリに保存する)', () => {
  it('フォルダを消しても、keep に挙げたファイル (同じインストールで入れたもの) は残す', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = 'ghost/keep-test';
    await putPackage(
      { key, kind: 'ghost', dir: 'keep-test', name: 'k', installedAt: 0 },
      new FileTree([
        ['ghost/master/dic/old.dic', enc('old')],
        ['ghost/master/dic/new.dic', enc('new')],
        ['ghost/master/gone.txt', enc('x')],
        ['ghost/master/descript.txt', enc('name,k')],
      ]),
    );
    await deletePackageFiles(key, ['ghost\\master\\dic\\', 'ghost\\master\\gone.txt', 'ghost\\master\\descript.txt'], ['ghost/master/dic/new.dic', 'ghost/master/descript.txt']);
    expect([...(await readPackageFiles(key)).entries()].map(([p]) => p).sort()).toEqual(['ghost/master/descript.txt', 'ghost/master/dic/new.dic']);
  });
});
