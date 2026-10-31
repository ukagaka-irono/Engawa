import { describe, expect, it } from 'vitest';
import createPasta from '../src/assets/shiori/pasta.mjs';
import PASTA_WASM from '../src/assets/shiori/pasta.wasm.gz?inline';
import { boot } from './native-boot';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('pasta (Rust と Lua 5.4、WebAssembly)', () => {
  const files = {
    'pasta.toml': utf8(['[loader]', 'pasta_patterns = ["dic/*.pasta"]', '', '[actor."女の子"]', 'spot = 0', 'default_surface = 0', '', '[actor."男の子"]', 'spot = 1', 'default_surface = 10', ''].join('\n')),
    'dic/boot.pasta': utf8(['＊OnBoot', '　女の子：やっほー、今日もよろしくね。', '　男の子：よろしく。', '', '＊OnClose', '　女の子：またね。', ''].join('\n')),
  };

  it('pasta.toml と dic/*.pasta を読み、シーンをさくらスクリプトにして返す', async () => {
    const m = await boot(createPasta, PASTA_WASM, files);
    expect(m.loaded, m.out.join('\n')).toBe(1);
    const res = m.get('OnBoot', 'UTF-8');
    expect(res, m.out.join('\n')).toMatch(/^SHIORI\/3\.0 200 OK/);
    expect(res).toContain('やっほー');
    expect(res).toContain('よろしく。');
    expect(m.get('OnClose', 'UTF-8')).toContain('またね');
    // 知らないイベントは 204
    expect(m.get('OnNoSuchEvent', 'UTF-8')).toMatch(/^SHIORI\/3\.0 204/);
    m.m._unload();
  });
});
