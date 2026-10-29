import { afterEach, describe, expect, it } from 'vitest';
import sampleShiori from '../sample/engawa/ghost/master/shiori.js?raw';
import { moduleToFunctionBody, runModuleScript } from '../src/shiori/module-script';

type Exports = Record<string, unknown>;

describe('moduleToFunctionBody', () => {
  it('行頭の export を外し、export したものを返す', async () => {
    const mod = (await runModuleScript(
      [
        'export function load(dir) { return dir; }',
        'export async function request(text) { return text + "!"; }',
        'export const version = 3;',
        'let hidden = 1;',
        'class Shiori {}',
        'export { hidden as visible, Shiori };',
        'export default function main() { return "main"; }',
      ].join('\n'),
      'shiori.js',
    )) as Exports;
    expect((mod.load as (d: string) => string)('x')).toBe('x');
    expect(await (mod.request as (t: string) => Promise<string>)('hi')).toBe('hi!');
    expect(mod.version).toBe(3);
    expect(mod.visible).toBe(1);
    expect(typeof mod.Shiori).toBe('function');
    expect((mod.default as () => string)()).toBe('main');
  });

  it('export default の式とトップレベルの await', async () => {
    const mod = (await runModuleScript('const v = await Promise.resolve(2);\nexport default { v };', 'a.js')) as Exports;
    expect(mod.default).toEqual({ v: 2 });
  });

  it('import 文は分かる言葉で断る', () => {
    expect(() => moduleToFunctionBody("import { x } from './x.js';", 'shiori.js')).toThrow(/engawa\.importModule/);
    expect(() => moduleToFunctionBody("export * from './x.js';", 'shiori.js')).toThrow(/import 文/);
    // import() や文字列中の "import" は断らない
    expect(() => moduleToFunctionBody("const s = 'import x';\nconst m = () => import('./x.js');", 'shiori.js')).not.toThrow();
  });
});

describe('サンプルゴーストの shiori.js', () => {
  const g = globalThis as unknown as { engawa?: unknown };
  afterEach(() => {
    delete g.engawa;
  });

  it('書き換えても読み込めて、OnBoot に答える', async () => {
    const saved = new Map<string, string>();
    g.engawa = {
      readText: (p: string) => saved.get(p),
      writeText: (p: string, t: string) => void saved.set(p, t),
      log: () => {},
    };
    const mod = (await runModuleScript(sampleShiori, 'shiori.js')) as Exports;
    (mod.load as (dir: string) => void)('ghost/master');
    const res = await (mod.request as (t: string) => string | Promise<string>)(
      'GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: Engawa\r\nID: OnBoot\r\nReference0: 0\r\n\r\n',
    );
    expect(res).toMatch(/^SHIORI\/3\.0 200 OK/);
    (mod.unload as () => void)();
    expect(saved.has('save.json')).toBe(true);
  });
});
