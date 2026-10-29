import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import createKawari from '../src/assets/shiori/kawari.mjs';
import KAWARI_WASM from '../src/assets/shiori/kawari.wasm.gz?inline';
import createKawari7 from '../src/assets/shiori/kawari7.mjs';
import KAWARI7_WASM from '../src/assets/shiori/kawari7.wasm.gz?inline';
import createAya5 from '../src/assets/shiori/aya5.mjs';
import AYA5_WASM from '../src/assets/shiori/aya5.wasm.gz?inline';
import createKagari from '../src/assets/shiori/kagari.mjs';
import KAGARI_WASM from '../src/assets/shiori/kagari.wasm.gz?inline';
import createMinato from '../src/assets/shiori/minato.mjs';
import MINATO_WASM from '../src/assets/shiori/minato.wasm.gz?inline';
import createNashi from '../src/assets/shiori/nashi.mjs';
import createQuickshiori from '../src/assets/shiori/quickshiori.mjs';
import QUICKSHIORI_WASM from '../src/assets/shiori/quickshiori.wasm.gz?inline';
import NASHI_WASM from '../src/assets/shiori/nashi.wasm.gz?inline';
import createSatori from '../src/assets/shiori/satori.mjs';
import SATORI_WASM from '../src/assets/shiori/satori.wasm.gz?inline';
import createYaya from '../src/assets/shiori/yaya.mjs';
import YAYA_WASM from '../src/assets/shiori/yaya.wasm.gz?inline';
import type { EmscriptenModule, EngineFactory } from '../src/shiori/native-engines';
import { buildRequest } from '../src/shiori/protocol';
import { fromShiori2, toShiori2 } from '../src/shiori/shiori2';
import { encodeCharset } from '../src/util/charset-encode';

/**
 * WebAssembly にした SHIORI (native/build.mjs が作ったもの) を、Worker の代わりに Node でそのまま動かす。
 * native-worker.ts と同じく、ゴーストのファイルをメモリ上のファイルシステムに置いて load / request / unload を呼ぶ。
 */
async function boot(create: EngineFactory, wasmDataUrl: string, files: Record<string, Uint8Array>) {
  const wasmBinary = gunzipSync(Uint8Array.from(atob(wasmDataUrl.slice(wasmDataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0)));
  const out: string[] = [];
  const m: EmscriptenModule = await create({ wasmBinary, locateFile: (p) => p, print: (s) => out.push(s), printErr: (s) => out.push(s) });
  const fs = m.FS as EmscriptenModule['FS'] & { mkdirTree(path: string): void };
  fs.mkdirTree('/ghost/master');
  for (const [path, data] of Object.entries(files)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir) fs.mkdirTree(`/ghost/master/${dir}`);
    fs.writeFile(`/ghost/master/${path}`, data);
  }
  const put = (bytes: Uint8Array) => {
    const p = m._malloc(bytes.length + 1);
    m.HEAPU8.set(bytes, p);
    m.HEAPU8[p + bytes.length] = 0;
    return p;
  };
  const dir = new TextEncoder().encode('/ghost/master/');
  const loaded = m._load(put(dir), dir.length);
  const raw = (bytes: Uint8Array): Uint8Array | undefined => {
    const lenPtr = m._malloc(4);
    m.HEAP32[lenPtr >> 2] = bytes.length;
    const res = m._request(put(bytes), lenPtr);
    const value = res ? m.HEAPU8.slice(res, res + m.HEAP32[lenPtr >> 2]) : undefined;
    if (res) m._free(res);
    m._free(lenPtr);
    return value;
  };
  /** SHIORI/3.0 の GET を送り、応答を charset で読む */
  const get = (id: string, charset = 'Shift_JIS', refs: string[] = []) => {
    const text = [`GET SHIORI/3.0`, `Charset: ${charset}`, 'Sender: Engawa', 'SecurityLevel: local', `ID: ${id}`, ...refs.map((r, i) => `Reference${i}: ${r}`)].join('\r\n');
    const res = raw(encodeCharset(text + '\r\n\r\n', charset));
    return res && new TextDecoder(charset).decode(res);
  };
  return { m, loaded, raw, get, out, read: (path: string) => m.FS.readFile(`/ghost/master/${path}`) };
}

const sjis = (text: string) => encodeCharset(text.replace(/\n/g, '\r\n'), 'Shift_JIS');

describe('YAYA (WebAssembly)', () => {
  it('辞書が無ければシェルモードで式を EVAL する。Shift_JIS は Windows の CP932 と同じ', async () => {
    const y = await boot(createYaya, YAYA_WASM, {});
    expect(y.loaded).toBe(1);
    const evalExpr = (expr: string) => new TextDecoder().decode(y.raw(new TextEncoder().encode(expr)));
    expect(evalExpr('1+2*3')).toBe('7');
    expect(evalExpr('STRENCODE("①～ⅰ髙","Shift_JIS")')).toBe('%87%40%81%60%FA%40%FB%FC');
    expect(evalExpr('STRDECODE("%87%40%81%60","Shift_JIS")')).toBe('①～');
    y.m._unload();
  });

  it('Shift_JIS の辞書で SHIORI/3.0 に答え、要求のたびにメモリを漏らさない', async () => {
    const y = await boot(createYaya, YAYA_WASM, {
      'yaya.txt': sjis('charset, Shift_JIS\ndic, test.dic\n'),
      // yaya_shiori3.dic の代わりの、いちばん小さな request (ID の関数を呼んで Value にする)
      'test.dic': sjis(
        [
          'request',
          '{',
          '  _d = RE_SEARCH(_argv[0], "ID: (\\w+)")',
          '  _v = EVAL(RE_GETSTR[1])',
          '  "SHIORI/3.0 200 OK" + CHR(13,10) + "Charset: Shift_JIS" + CHR(13,10) + "Value: " + _v + CHR(13,10) + CHR(13,10)',
          '}',
          'OnBoot',
          '{',
          '  "\\0\\s[0]こんにちは①\\e"',
          '}',
          'OnSecondChange',
          '{',
          '  ""',
          '}',
        ].join('\n'),
      ),
    });
    expect(y.get('OnBoot')).toBe('SHIORI/3.0 200 OK\r\nCharset: Shift_JIS\r\nValue: \\0\\s[0]こんにちは①\\e\r\n\r\n');
    const heap = y.m.HEAPU8.length;
    for (let i = 0; i < 5000; i++) y.get('OnSecondChange');
    expect(y.m.HEAPU8.length).toBe(heap);
    y.m._unload();
  });
});

describe('里々 (WebAssembly)', () => {
  const dic = sjis(
    [
      '＊OnBoot',
      '：こんにちは①、（calc、1＋2＊3）。',
      '',
      '＊OnVar',
      '＄回数＝５',
      '：回数は（回数）',
      '',
      '＊OnSecondChange',
      '',
    ].join('\n'),
  );

  it('Shift_JIS の辞書で SHIORI/3.0 に答える', async () => {
    const s = await boot(createSatori, SATORI_WASM, { 'dic_test.txt': dic });
    expect(s.loaded).toBe(1);
    const res = s.get('OnBoot', 'Shift_JIS', ['master']);
    expect(res).toMatch(/^SHIORI\/3\.0 200 OK/);
    // 里々は句読点の後に \_w[…] の待ちを入れる
    expect(res).toContain('Value: \\1\\s[10]\\0こんにちは①、\\_w[42]7。\\e');
    expect(s.get('OnVar')).toContain('回数は５'); // 里々は数を全角で出す
    s.m._unload();
  });

  it('unload でセーブデータを書き、次の起動で読み戻す', async () => {
    const s = await boot(createSatori, SATORI_WASM, {
      'dic_test.txt': sjis(['＊OnSet', '＄回数＝（Reference0）', '：', '', '＊OnGet', '：回数は（回数）', ''].join('\n')),
    });
    s.get('OnSet', 'Shift_JIS', ['42']);
    s.m._unload();
    const save = s.read('satori_savedata.txt');
    const again = await boot(createSatori, SATORI_WASM, { 'dic_test.txt': s.read('dic_test.txt'), 'satori_savedata.txt': save });
    expect(again.get('OnGet')).toContain('回数は４２');
    again.m._unload();
  });
});

describe('華和梨 8 (WebAssembly)', () => {
  it('kawarirc.kis を読み、SHIORI/3.0 の GET に答える', async () => {
    const k = await boot(createKawari, KAWARI_WASM, {
      'kawarirc.kis': sjis(
        [
          '#   GET では、要求の ID と同じ名前のエントリを呼ぶ',
          'System.Callback.OnGET : $(entry ${System.Request.ID})',
          'OnBoot : \\0\\s[0]こんにちは①、$[1 + 2 * 3]。\\e',
          '',
        ].join('\n'),
      ),
    });
    expect(k.loaded).toBe(1);
    const res = k.get('OnBoot');
    expect(res).toMatch(/^SHIORI\/3\.0 200 OK/);
    expect(res).toContain('Value: \\0\\s[0]こんにちは①、7。\\e');
    // 知らない ID には 204
    expect(k.get('OnUnknown')).toMatch(/^SHIORI\/3\.0 204/);
    k.m._unload();
  });
});

describe('華和梨 7 (WebAssembly、SHIORI/2.x)', () => {
  it('kawari.ini を読み、3.0 の要求を 2.x に読み替えて答える', async () => {
    const k = await boot(createKawari7, KAWARI7_WASM, {
      'kawari.ini': sjis('dict : dict.txt\n'),
      'dict.txt': sjis(['event.OnBoot : \\0\\s0こんにちは①\\e', 'resource.homeurl : http://example.com/', ''].join('\n')),
    });
    expect(k.loaded).toBe(1);
    // NativeShiori と同じく、SHIORI/2.x の要求に読み替えて Shift_JIS で送る
    const ask = (id: string) => {
      const req = toShiori2(buildRequest({ method: 'GET', id, references: ['0'] }).replace('Charset: UTF-8', 'Charset: Shift_JIS'))!;
      return fromShiori2(new TextDecoder('shift_jis').decode(k.raw(encodeCharset(req.text, 'Shift_JIS'))), req);
    };
    expect(ask('OnBoot')).toMatch(/^SHIORI\/3\.0 200 OK\r\n(?:.*\r\n)*Value: \\0\\s0こんにちは①\\e\r\n/);
    expect(ask('homeurl')).toContain('Value: http://example.com/');
    expect(ask('OnUnknownEvent')).toMatch(/^SHIORI\/3\.0 204/);
    k.m._unload();
  });
});

describe('なし栞 (WebAssembly、windows.h の代わりで組んだもの)', () => {
  const ghost = {
    format: 'nashi/1',
    meta: { name: 'テスト', sakuraName: 'さくら', keroName: 'うにゅう', craftman: 'test', version: '1.0.0' },
    settings: { randomTalkInterval: 5, randomTalkEnabled: false },
    variables: [{ name: '好感度', value: 10 }],
    scripts: [
      {
        id: 's_boot',
        kind: 'event',
        event: 'OnBoot',
        blocks: [
          { type: 'change', name: '好感度', value: 1 },
          { type: 'say', who: 0, text: 'おかえりなさい①' },
        ],
      },
    ],
  };

  it('ghost.json を読んで OnBoot に答え、unload で変数を nashi_save.json に書く', async () => {
    const n = await boot(createNashi, NASHI_WASM, { 'ghost.json': new TextEncoder().encode(JSON.stringify(ghost)) });
    expect(n.loaded).toBe(1);
    const res = n.get('OnBoot', 'UTF-8');
    expect(res).toMatch(/^SHIORI\/3\.0 200 OK/);
    expect(res).toContain('おかえりなさい①');
    n.m._unload();
    const save = JSON.parse(new TextDecoder().decode(n.read('nashi_save.json')));
    expect(JSON.stringify(save)).toContain('11');
  });
});

describe('文 (AYA5、WebAssembly)', () => {
  it('aya5.txt と Shift_JIS の辞書を読み、正規表現 (std::regex で作り直したもの) も動く', async () => {
    const a = await boot(createAya5, AYA5_WASM, {
      'aya5.txt': sjis('charset, Shift_JIS\ndic, test.dic\n'),
      'test.dic': sjis(
        [
          'request',
          '{',
          '  _v = ""',
          '  if RE_SEARCH(_argv[0], "ID: OnBoot") {',
          '    _v = "\\0\\s[0]こんにちは①、" + RE_GREP("a1b22c333", "[0-9]+") + "。\\e"',
          '  }',
          '  "SHIORI/3.0 200 OK" + CHR(13) + CHR(10) + "Charset: Shift_JIS" + CHR(13) + CHR(10) + "Value: " + _v + CHR(13) + CHR(10) + CHR(13) + CHR(10)',
          '}',
        ].join('\n'),
      ),
    });
    expect(a.loaded).toBe(1);
    expect(a.get('OnBoot')).toBe('SHIORI/3.0 200 OK\r\nCharset: Shift_JIS\r\nValue: \\0\\s[0]こんにちは①、3。\\e\r\n\r\n');
    a.m._unload();
  });
});

describe('minato (Rust、WebAssembly)', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const files = {
    'config.toml': utf8('[characters]\n"さくら" = \'\\0\'\n'),
    'talks/main.mnt': utf8(['OnBoot => {', '    [0]さくら:こんにちは①', '}', '', 'OnSet => {', '    global save.count = 42', '}', '', 'OnGet => {', '    [0]さくら:${save.count}', '}', ''].join('\n')),
  };

  it('config.toml と talks/*.mnt を読み、変数を save.json に保存して次の起動で読み戻す', async () => {
    const m = await boot(createMinato, MINATO_WASM, files);
    expect(m.loaded).toBe(1);
    const res = m.get('OnBoot', 'UTF-8');
    expect(res).toMatch(/^SHIORI\/3\.0 200 OK/);
    expect(res).toContain('こんにちは①');
    m.get('OnSet', 'UTF-8');
    m.m._unload();
    const again = await boot(createMinato, MINATO_WASM, { ...files, 'save.json': m.read('save.json') });
    expect(again.get('OnGet', 'UTF-8')).toContain('42');
    again.m._unload();
  });
});

describe('kagari (Lua 5.4、WebAssembly)', () => {
  // kotori などが require する C モジュールの代わり (native/shim/kagari_engawa.cpp) を使う index.lua
  const index = [
    'local utf8x = require("lua-utf8")',
    'local lc = require("luachild")',
    'local iconv = require("iconv")',
    'local M = {}',
    'local dir',
    'function M.load(path) dir = path return true end',
    'function M.request(req)',
    '  local id = req:match("ID: ([^\\r\\n]+)")',
    '  local codes = {}',
    '  for _, c in utf8x.next, "あ①" do codes[#codes + 1] = c end',
    '  local files = {}',
    '  for e in lc.dir(dir .. "sub") do files[#files + 1] = e.name .. ":" .. e.type end',
    '  table.sort(files)',
    '  local sjis = iconv.new("CP932", "UTF-8"):iconv("①")',
    '  local value = id .. " " .. table.concat(codes, ",") .. " " .. table.concat(files, ",") .. " " .. string.format("%02X%02X", sjis:byte(1, 2))',
    '  return "SHIORI/3.0 200 OK\\r\\nCharset: UTF-8\\r\\nValue: " .. value .. "\\r\\n\\r\\n"',
    'end',
    'function M.unload() return true end',
    'return M',
    '',
  ].join('\n');

  it('index.lua を読み、lua-utf8・luachild・iconv の代わりが動く', async () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const k = await boot(createKagari, KAGARI_WASM, { 'index.lua': utf8(index), 'sub/a.txt': utf8('a'), 'sub/d/x.txt': utf8('x') });
    expect(k.loaded).toBe(1);
    expect(k.get('OnBoot', 'UTF-8')).toBe('SHIORI/3.0 200 OK\r\nCharset: UTF-8\r\nValue: OnBoot 12354,9312 a.txt:file,d:directory 8740\r\n\r\n');
    k.m._unload();
  });
});

describe('quickshiori (QuickJS、WebAssembly)', () => {
  it('index.js の __shiori_request に答えさせる (新しい構文も使える)', async () => {
    const index = [
      'let dir = "";',
      'globalThis.__shiori_load = (d) => { dir = d; };',
      'globalThis.__shiori_request = (raw) => {',
      '  const id = raw.match(/^ID: (.*)$/m)?.[1] ?? "";',
      '  const value = `\\\\0\\\\s[0]${id}①、${[1, 2, 3].map((n) => n * 2).join(",")}\\\\e`;',
      '  return `SHIORI/3.0 200 OK\\r\\nCharset: UTF-8\\r\\nValue: ${value}\\r\\n\\r\\n`;',
      '};',
      'globalThis.__shiori_unload = () => {};',
      '',
    ].join('\n');
    const q = await boot(createQuickshiori, QUICKSHIORI_WASM, { 'index.js': new TextEncoder().encode(index) });
    expect(q.loaded).toBe(1);
    expect(q.get('OnBoot', 'UTF-8')).toBe('SHIORI/3.0 200 OK\r\nCharset: UTF-8\r\nValue: \\0\\s[0]OnBoot①、2,4,6\\e\r\n\r\n');
    q.m._unload();
  });
});
