import { describe, expect, it } from 'vitest';
import createEmo from '../src/assets/shiori/emo.mjs';
import EMO_WASM from '../src/assets/shiori/emo.wasm.gz?inline';
import { boot } from './native-boot';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('emo (Rust と Lua 5.3、WebAssembly)', () => {
  // emo は package.path を profile/emo/save・dic・emo の順にして require("shiori") する。ゴーストの emo/shiori/init.lua の代わり
  const files = {
    'emo/shiori/init.lua': utf8(
      [
        'local talk = require("talk")',
        'local M = {}',
        'shiori = M',
        'local dir',
        'function M.load(hinst, load_dir) dir = load_dir return true end',
        'function M.request(req)',
        '  if req.id == "OnError" then error("boom") end',
        '  lfs.mkdir(dir .. "profile/emo/save/made")',
        '  local value = talk[req.id] and talk[req.id](req.reference[0]) or emo.rust_hello(req.method)',
        '  return "SHIORI/3.0 200 OK\\r\\nCharset: UTF-8\\r\\nValue: " .. value .. "\\r\\n\\r\\n"',
        'end',
        'function M.unload() return true end',
        'return M',
        '',
      ].join('\n'),
    ),
    'dic/talk.lua': utf8(['return {', '  OnBoot = function(r) return "\\\\0やっほー、" .. r .. "\\\\e" end,', '}', ''].join('\n')),
  };

  it('emo/shiori/init.lua を読み、dic の Lua も require できる。Lua のエラーは ErrorLevel 付きの 500', async () => {
    const m = await boot(createEmo, EMO_WASM, files);
    expect(m.loaded, m.out.join('\n')).toBe(1);
    expect(m.get('OnBoot', 'UTF-8', ['マスター'])).toContain('Value: \\0やっほー、マスター\\e\r\n');
    expect(m.get('OnSecondChange', 'UTF-8')).toContain('Value: Hello, get!\r\n');
    // lfs.mkdir と、load が作る save フォルダ・ログ
    expect(m.m.FS.analyzePath('/ghost/master/profile/emo/save/made').exists).toBe(true);
    expect(m.m.FS.analyzePath('/ghost/master/profile/emo/emo.log').exists).toBe(true);
    const err = m.get('OnError', 'UTF-8');
    expect(err).toMatch(/^SHIORI\/3\.0 500/);
    expect(err).toMatch(/ErrorLevel: error\r\nErrorDescription: .*boom/);
    m.m._unload();
  });
});
