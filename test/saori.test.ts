import { describe, expect, it } from 'vitest';
import createAya5 from '../src/assets/shiori/aya5.mjs';
import AYA5_WASM from '../src/assets/shiori/aya5.wasm.gz?inline';
import createKagari from '../src/assets/shiori/kagari.mjs';
import KAGARI_WASM from '../src/assets/shiori/kagari.wasm.gz?inline';
import createKawari from '../src/assets/shiori/kawari.mjs';
import KAWARI_WASM from '../src/assets/shiori/kawari.wasm.gz?inline';
import createKawari7 from '../src/assets/shiori/kawari7.mjs';
import KAWARI7_WASM from '../src/assets/shiori/kawari7.wasm.gz?inline';
import createMinato from '../src/assets/shiori/minato.mjs';
import MINATO_WASM from '../src/assets/shiori/minato.wasm.gz?inline';
import createNashi from '../src/assets/shiori/nashi.mjs';
import NASHI_WASM from '../src/assets/shiori/nashi.wasm.gz?inline';
import createQuickshiori from '../src/assets/shiori/quickshiori.mjs';
import QUICKSHIORI_WASM from '../src/assets/shiori/quickshiori.wasm.gz?inline';
import createSatori from '../src/assets/shiori/satori.mjs';
import SATORI_WASM from '../src/assets/shiori/satori.wasm.gz?inline';
import createYaya from '../src/assets/shiori/yaya.mjs';
import YAYA_WASM from '../src/assets/shiori/yaya.wasm.gz?inline';
import { buildRequest } from '../src/shiori/protocol';
import { fromShiori2, toShiori2 } from '../src/shiori/shiori2';
import { encodeCharset } from '../src/util/charset-encode';
import { boot } from './native-boot';

/**
 * WebAssembly にした SHIORI から SAORI を呼ぶ (native/shim/engawa_saori.c → src/saori/host.ts)。
 * どの SHIORI でも、JavaScript で作り直した textcopy2.dll を呼ぶ。
 * textcopy2 は Argument1 が 1 なら Argument0 を Result に返し、Argument0 をクリップボードに写すよう頼む。
 */

const sjis = (text: string) => encodeCharset(text.replace(/\n/g, '\r\n'), 'Shift_JIS');
const utf8 = (text: string) => new TextEncoder().encode(text);
/** DLL の代わり。中身は書き出し表の DLL の名前だけ (detect.ts はそれで見分ける) */
const dll = (name: string) => utf8(`MZ....${name}\0load\0request\0unload\0`);
const TEXTCOPY = { 'saori/textcopy2.dll': dll('textcopy2.dll') };
const COPIED = [{ kind: 'clipboard', text: 'こんにちは' }];

const value = (res: string | undefined) => /^Value: (.*)$/m.exec(res ?? '')?.[1];

/** OnTest の中身を YAYA (または文) の文で書いたゴースト */
function yayaDic(body: string) {
  return sjis(
    [
      'request',
      '{',
      '  _d = RE_SEARCH(_argv[0], "ID: ([A-Za-z]+)")',
      '  _v = EVAL(RE_GETSTR[1])',
      '  "SHIORI/3.0 200 OK" + CHR(13) + CHR(10) + "Charset: Shift_JIS" + CHR(13) + CHR(10) + "Value: " + _v + CHR(13) + CHR(10) + CHR(13) + CHR(10)',
      '}',
      'OnTest',
      '{',
      body,
      '}',
    ].join('\n'),
  );
}

/** YAYA・文の文: LOADLIB で開いて REQUESTLIB で SAORI/1.0 の EXECUTE を送り、応答の改行を | にして返す */
function execute(dllPath: string, ...args: string[]): string {
  const crlf = ' + CHR(13) + CHR(10) + ';
  const lines = ['"EXECUTE SAORI/1.0"', '"Charset: Shift_JIS"', ...args.map((a, i) => `"Argument${i}: ${a}"`)];
  return [`  _ok = LOADLIB("${dllPath}")`, `  REPLACE(REQUESTLIB("${dllPath}", ${lines.join(crlf)}${crlf}CHR(13) + CHR(10)), CHR(13) + CHR(10), "|")`].join('\n');
}

describe('SAORI (WebAssembly の SHIORI から)', () => {
  it('YAYA: LOADLIB・REQUESTLIB (POSIX 版の dlopen と ninix の形の関数)', async () => {
    const y = await boot(createYaya, YAYA_WASM, {
      'yaya.txt': sjis('charset, Shift_JIS\ndic, test.dic\n'),
      'test.dic': yayaDic(execute('saori/textcopy2.dll', 'こんにちは', '1')),
      ...TEXTCOPY,
    });
    expect(value(y.get('OnTest'))).toBe('SAORI/1.0 200 OK|Charset: Shift_JIS|Result: こんにちは||');
    expect(y.effects).toEqual(COPIED);
    y.m._unload();
  });

  it('文: LOADLIB・REQUESTLIB (dlopen とふつうの DLL の形の関数)', async () => {
    const a = await boot(createAya5, AYA5_WASM, {
      'aya5.txt': sjis('charset, Shift_JIS\ndic, test.dic\n'),
      'test.dic': yayaDic(execute('saori/textcopy2.dll', 'こんにちは', '1')),
      ...TEXTCOPY,
    });
    expect(value(a.get('OnTest'))).toBe('SAORI/1.0 200 OK|Charset: Shift_JIS|Result: こんにちは||');
    expect(a.effects).toEqual(COPIED);
    a.m._unload();
  });

  it('里々: satori_conf.txt の ＠SAORI に登録して （呼び名,引数…） で呼ぶ', async () => {
    const s = await boot(createSatori, SATORI_WASM, {
      // ＠SAORI は satori_conf.txt に書く (SAORI を読み込んでから辞書を読む)
      'satori_conf.txt': sjis(['＠SAORI', 'tc,saori/textcopy2.dll', ''].join('\n')),
      'dic_test.txt': sjis(['＊OnTest', '：（tc,こんにちは,1）', ''].join('\n')),
      ...TEXTCOPY,
    });
    expect(s.get('OnTest')).toContain('こんにちは');
    expect(s.effects).toEqual(COPIED);
    s.m._unload();
  });

  it('華和梨 8: saoriregist と callsaori (SAORI_NATIVE)', async () => {
    const k = await boot(createKawari, KAWARI_WASM, {
      'kawarirc.kis': sjis(
        [
          '=kis',
          'saoriregist ${System.DataPath}saori/textcopy2.dll tc;',
          '=end',
          'System.Callback.OnGET : $(entry ${System.Request.ID})',
          'OnTest : $(callsaori tc こんにちは 1)',
          '',
        ].join('\n'),
      ),
      ...TEXTCOPY,
    });
    expect(value(k.get('OnTest'))).toBe('こんにちは');
    expect(k.effects).toEqual(COPIED);
    k.m._unload();
  });

  it('華和梨 7: saoriregist と callsaori (先頭に _ の付いた関数の名前)', async () => {
    const k = await boot(createKawari7, KAWARI7_WASM, {
      'kawari.ini': sjis('dict : dict.txt\n'),
      'dict.txt': sjis('event.OnTest : $(saoriregist saori/textcopy2.dll tc)$(callsaori tc こんにちは 1)\n'),
      ...TEXTCOPY,
    });
    const req = toShiori2(buildRequest({ method: 'GET', id: 'OnTest', references: [] }).replace('Charset: UTF-8', 'Charset: Shift_JIS'))!;
    const res = fromShiori2(new TextDecoder('shift_jis').decode(k.raw(encodeCharset(req.text, 'Shift_JIS'))), req);
    expect(value(res)).toBe('こんにちは');
    expect(k.effects).toEqual(COPIED);
    k.m._unload();
  });

  it('なし栞: saori のブロック (windows.h の代わりの LoadLibraryW)', async () => {
    const ghost = {
      format: 'nashi/1',
      meta: { name: 'テスト', sakuraName: 'さくら', keroName: 'うにゅう', craftman: 'test', version: '1.0.0' },
      settings: { randomTalkInterval: 5, randomTalkEnabled: false },
      variables: [{ name: '答え', value: '' }],
      scripts: [
        {
          id: 's_test',
          kind: 'event',
          event: 'OnTest',
          blocks: [
            { type: 'set', name: '答え', value: { type: 'saori', file: 'saori/textcopy2.dll', a: 'こんにちは', b: '1', value: -1 } },
            { type: 'say', who: 0, text: { type: 'var', name: '答え' } },
          ],
        },
      ],
    };
    const n = await boot(createNashi, NASHI_WASM, { 'ghost.json': utf8(JSON.stringify(ghost)), ...TEXTCOPY });
    expect(n.get('OnTest', 'UTF-8')).toContain('こんにちは');
    expect(n.effects).toEqual(COPIED);
    n.m._unload();
  });

  it('minato: saori() (Rust の winapi の代わりの LoadLibraryW)', async () => {
    const m = await boot(createMinato, MINATO_WASM, {
      'config.toml': utf8('[characters]\n"さくら" = \'\\0\'\n'),
      'talks/main.mnt': utf8(['OnTest => {', '    let r = saori("saori/textcopy2.dll", "こんにちは", "1")', '    [0]さくら:${r[0]}', '}', ''].join('\n')),
      ...TEXTCOPY,
    });
    expect(m.get('OnTest', 'UTF-8')).toContain('こんにちは');
    expect(m.effects).toEqual(COPIED);
    m.m._unload();
  });

  it('kagari: saori_universal.native (kotori の SAORI の呼び方)', async () => {
    const index = [
      'local Native = require("saori_universal.native")',
      'local M = {}',
      'local saori',
      'function M.load(dir)',
      '  saori = Native(dir .. "saori/textcopy2.dll")',
      '  return saori:load(dir .. "saori/")',
      'end',
      'function M.request(req)',
      '  local res = saori:request("EXECUTE SAORI/1.0\\r\\nCharset: UTF-8\\r\\nArgument0: こんにちは\\r\\nArgument1: 1\\r\\n\\r\\n")',
      '  return "SHIORI/3.0 200 OK\\r\\nCharset: UTF-8\\r\\nValue: " .. res:match("Result: ([^\\r\\n]*)") .. "\\r\\n\\r\\n"',
      'end',
      'function M.unload() return saori:unload() end',
      'return M',
      '',
    ].join('\n');
    const k = await boot(createKagari, KAGARI_WASM, { 'index.lua': utf8(index), ...TEXTCOPY });
    expect(value(k.get('OnTest', 'UTF-8'))).toBe('こんにちは');
    expect(k.effects).toEqual(COPIED);
    k.m._unload();
  });

  it('quickshiori: ukadll の UkaDll (組み込みにしたもの)', async () => {
    const index = [
      'import { UkaDll } from "ukadll.dll";',
      'let dll;',
      'globalThis.__shiori_load = () => {',
      '  dll = new UkaDll(__shiori_dir + "/saori/textcopy2.dll");',
      '  dll.load(__shiori_dir + "/saori/");',
      '};',
      'globalThis.__shiori_request = () => {',
      '  const res = dll.request("EXECUTE SAORI/1.0\\r\\nCharset: UTF-8\\r\\nArgument0: こんにちは\\r\\nArgument1: 1\\r\\n\\r\\n");',
      '  return `SHIORI/3.0 200 OK\\r\\nCharset: UTF-8\\r\\nValue: ${res.match(/^Result: (.*)\\r$/m)[1]}\\r\\n\\r\\n`;',
      '};',
      'globalThis.__shiori_unload = () => dll.unload();',
      '',
    ].join('\n');
    const q = await boot(createQuickshiori, QUICKSHIORI_WASM, { 'index.js': utf8(index), ...TEXTCOPY });
    expect(value(q.get('OnTest', 'UTF-8'))).toBe('こんにちは');
    expect(q.effects).toEqual(COPIED);
    q.m._unload();
  });
});
