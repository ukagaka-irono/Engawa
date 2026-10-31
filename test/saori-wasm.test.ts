import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import BUDOUX_WASM from '../src/assets/saori/budoux.wasm.gz?inline';
import CALCS_WASM from '../src/assets/saori/calcs.wasm.gz?inline';
import GENGOU_WASM from '../src/assets/saori/gengou.wasm.gz?inline';
import KISARAGI_WASM from '../src/assets/saori/kisaragi.wasm.gz?inline';
import MAHJONGUTIL_WASM from '../src/assets/saori/mahjongutil.wasm.gz?inline';
import NODOKA_WASM from '../src/assets/saori/nodoka.wasm.gz?inline';
import MIO_WASM from '../src/assets/saori/mio.wasm.gz?inline';
import PIECHART_WASM from '../src/assets/saori/piechart.wasm.gz?inline';
import QRCODE_WASM from '../src/assets/saori/qrcode.wasm.gz?inline';
import RESIZEDPNG_WASM from '../src/assets/saori/resizedpng.wasm.gz?inline';
import RESIZEDPNGMINI_WASM from '../src/assets/saori/resizedpngmini.wasm.gz?inline';
import SQLORI_WASM from '../src/assets/saori/sqlori.wasm.gz?inline';
import SQLORI2_WASM from '../src/assets/saori/sqlori2.wasm.gz?inline';
import SSU_WASM from '../src/assets/saori/ssu.wasm.gz?inline';
import TEXASHOLDEM_WASM from '../src/assets/saori/texasholdem.wasm.gz?inline';
import TIMEBKN_WASM from '../src/assets/saori/timebkn.wasm.gz?inline';
import XAORIC_WASM from '../src/assets/saori/xaoric.wasm.gz?inline';
import YAYA_WASM from '../src/assets/shiori/yaya.wasm.gz?inline';
import type { WasmSaoriKind } from '../src/saori/detect';
import { openSaori } from './native-boot';

/**
 * WebAssembly にした SAORI (native/saoris.mjs)。SHIORI (ここでは YAYA) の Worker と同じ置き場 (SaoriHost) から、
 * SHIORI が DLL を呼ぶのと同じ口 (bridge の open・load・request) で呼ぶ。
 */

/** WebAssembly の SAORI を、DLL のパスと本体 (vite の ?inline) で開く */
const saori = (kind: WasmSaoriKind, url: string, dllPath: string, files: Record<string, Uint8Array> = {}) => openSaori(dllPath, files, [kind, url]);

describe('xaoric (CSaori の XPath、WebAssembly)', () => {
  it('XML を開いて XPath で読む', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<root><item id="1">りんご</item><item id="2">みかん</item></root>\n';
    const s = await saori('xaoric', XAORIC_WASM, 'saori/xaoric.dll', { 'saori/fruit.xml': new TextEncoder().encode(xml) });
    const id = s.execute('open', 'fruit.xml').result!;
    expect(id).toMatch(/^\d+$/);
    expect(s.execute('get', id, '/root/item')).toMatchObject({ status: 200, values: ['りんご', 'みかん'] });
    expect(s.execute('get', id, 'count(/root/item)').result).toBe('2');
    expect(s.execute('get', id, '/root/item[@id="2"]/@id').result).toBe('2');
    expect(s.execute('close', id).status).toBe(204);
  });
});

describe('sqlori (CSaori の SQLite、WebAssembly)', () => {
  it('DLL のディレクトリのデータベースを読み書きし、書いたファイルをメインスレッドへ送る', async () => {
    const s = await saori('sqlori', SQLORI_WASM, 'saori/sqlori.dll');
    expect(s.execute('OPEN').result).toBe('0\u0002');
    s.execute('EXEC', 'CREATE TABLE talk (id INTEGER, text TEXT)');
    s.execute('EXEC', "INSERT INTO talk VALUES (1, 'こんにちは')");
    expect(s.execute('EXEC', 'SELECT * FROM talk').result).toBe('0\u0002id\u0003text\u00021\u0003こんにちは');
    s.execute('CLOSE');
    const written = s.y.effects.filter((e) => e.kind === 'write').map((e) => e.path);
    expect(written).toContain('ghost/master/saori/sqlori.db');
    // SHIORI のファイルシステムにも写してある (セーブデータと同じく flush で残る)
    expect(new TextDecoder('latin1').decode(s.y.read('saori/sqlori.db').subarray(0, 15))).toBe('SQLite format 3');
  });
});

describe('sqlori-sqlite2 (CSaori の SQLite 2、WebAssembly)', () => {
  it('SQLite 2 のデータベースを読み書きする', async () => {
    const s = await saori('sqlori2', SQLORI2_WASM, 'saori/sqlori-sqlite2.dll');
    expect(s.execute('OPEN').result).toBe('0');
    s.execute('EXEC', 'CREATE TABLE talk (id, text)');
    s.execute('EXEC', "INSERT INTO talk VALUES (1, 'こんにちは')");
    expect(s.execute('EXEC', 'SELECT * FROM talk').result).toBe('0idtext1こんにちは');
    s.execute('CLOSE');
    expect(new TextDecoder('latin1').decode(s.y.read('saori/sqlori.db').subarray(0, 47))).toBe('** This file contains an SQLite 2.1 database **');
  });
});

describe('kisaragi (CSaori の MeCab、WebAssembly)', () => {
  it('辞書 (dic/) が無ければ、その理由を Value0 に返す', async () => {
    const s = await saori('kisaragi', KISARAGI_WASM, 'saori/kisaragi.dll');
    const r = s.execute('parse', '如月と申します。');
    expect(r.result).toBe('-1');
    expect(r.values[0]).toMatch(/dicrc|no such file/);
  });
});

describe('timebkn (CSaori、WebAssembly)', () => {
  it('fromdate で時刻にし、qreki で旧暦と六曜を返す', async () => {
    const s = await saori('timebkn', TIMEBKN_WASM, 'saori/timebkn.dll');
    const t = s.execute('fromdate', '2024', '2', '10', '12', '0', '0').result!;
    expect(Number(t)).toBeGreaterThan(1.7e9);
    // 2024年2月10日は旧暦の正月 (先勝)
    expect(s.execute('qreki', t)).toMatchObject({ status: 200, result: '2024,1,1,先勝', values: ['2024', '1', '1', '先勝', '0'] });
    expect(s.execute('strftime', t, '%Y/%m/%d %H時').result).toBe('2024/02/10 12時');
    expect(s.unload()).toBe(1);
  });
});

describe('麻雀・ポーカー (WebAssembly)', () => {
  it('MahjongUtil (CSaori): 向聴数と待ち', async () => {
    const s = await saori('mahjongutil', MAHJONGUTIL_WASM, 'saori/MahjongUtil.dll');
    // readme.txt の例 (Value は考えられる組み合わせすべて。readme にあるのは最初のもの)
    const r = s.execute('shanten', '1m2m3m5p6p7p8p9p9p2s3s4s4s');
    expect(r.result).toBe('1');
    expect(r.values[0]).toBe('9p9p,1m2m3m,5p7p,6p8p,2s3s4s,4s');
    expect(s.execute('shanten', '2p2p3p3p4p4p5p5p6p6p7p7p8p8p').result).toBe('-1');
  });

  it('mahjong_nodoka: 向聴数・有効牌・不要牌', async () => {
    const s = await saori('nodoka', NODOKA_WASM, 'saori/nodoka.dll');
    // README の例 (牌の並びは決まっていないので、集合として比べる)
    const [shanten, effective, unneeded] = s.execute('shanten', '3m4m4m5m5m6m6m7m7m8m9m<1m2m3m>', '1m2m3m3m4m4m5m5m6m6m7m7m8m9m').result!.split(',');
    const tiles = (t: string) => t.match(/\d[mpsz]/g)!.sort();
    expect(shanten).toBe('0');
    expect(tiles(effective)).toEqual(tiles('6m8m9m7m3m2m5m4m'));
    expect(tiles(unneeded)).toEqual(tiles('6m4m3m7m9m'));
  });

  it('connect6_mio: 六目並べの手番・着手・探索', async () => {
    const s = await saori('mio', MIO_WASM, 'saori/mio/mio.dll');
    s.execute('init');
    expect(s.execute('teban').result).toBe('Black');
    expect(s.execute('put', '7', '7').result).toBe('true');
    expect(s.execute('isGameOver')).toMatchObject({ result: 'False', values: ['Continue'] });
    const r = s.execute('search', '1');
    expect(r.values[0]).toMatch(/^\d+,\d+$/);
  });

  it('TexasHoldemUtil: 役 (ロイヤルストレートフラッシュはストレートフラッシュの 9)', async () => {
    const s = await saori('texasholdem', TEXASHOLDEM_WASM, 'saori/TexasHoldemUtil.dll');
    expect(s.execute('hand', 'S1', 'S13', 'S12', 'S11', 'S10', 'H2', 'D3').result).toBe('9');
    expect(s.execute('hand', 'S1', 'H1', 'D5', 'C9', 'S7', 'H2', 'D3').result).toBe('2');
  });
});

describe('文字列・計算 (WebAssembly)', () => {
  it('ssu (里々に付いてくるもの): calc', async () => {
    const s = await saori('ssu', SSU_WASM, 'saori/ssu.dll');
    expect(s.execute('calc', '1+2*3').result).toBe('7');
  });

  it('saori-calcs: 四則演算 (全角の数字・記号も読む。小数の扱いはモードで決める)', async () => {
    const s = await saori('calcs', CALCS_WASM, 'saori/calcs.dll');
    expect(s.execute('', '(1+2)*3').result).toBe('9');
    // README の例。モードの名前は日本語でも書ける (Shift_JIS で送る)
    expect(s.execute('前切り捨て', '１．８＋１．２').result).toBe('2');
    expect(s.execute('後切り捨て', '１．８＋１．２').result).toBe('3');
    expect(s.execute('after_floor', '１．５÷０．３').result).toBe('5');
  });

  it('saori-japanese-gengou: 西暦を和暦に (DLL の隣の gengou_lists を読む)', async () => {
    const list = ['// 明治以降', '明治,1868-01-25,1912-07-29', '大正,1912-07-30,1926-12-24', '昭和,1926-12-25,1989-01-07', '平成,1989-01-08,2019-04-30', '令和,2019-05-01,****', ''].join('\r\n');
    const s = await saori('gengou', GENGOU_WASM, 'saori/japanesegengou.dll', { 'saori/gengou_lists/005_meijiIkou.txt': new TextEncoder().encode(list) });
    expect(s.execute('2024', '2', '10').result).toMatch(/^令和/);
    expect(s.execute('1989', '1', '7').result).toMatch(/^昭和/);
  });

  it('saori_budoux: 文を区切る (DLL の隣の model.json を読み、UTF-8 で答えたものを要求の Shift_JIS に直す)', async () => {
    const model = JSON.stringify({ UW4: { は: 1000 } });
    const s = await saori('budoux', BUDOUX_WASM, 'saori/budoux.dll', { 'saori/model.json': new TextEncoder().encode(model) });
    expect(s.execute('今日は晴れ')).toMatchObject({ result: '2', values: ['今日', 'は晴れ'] });
    expect(s.execute('今日は晴れ').raw).toContain('Charset: Shift_JIS');
  });

  it('yaya-as-saori: SAORI として開いた YAYA が、DLL のディレクトリの yaya.txt と辞書で答える', async () => {
    const dic = [
      'request',
      '{',
      '  _d = RE_SEARCH(_argv[0], "Argument0: ([^\\r\\n]*)")',
      '  "SAORI/1.0 200 OK" + CHR(13) + CHR(10) + "Charset: UTF-8" + CHR(13) + CHR(10) + "Result: " + TOUPPER(RE_GETSTR[1]) + CHR(13) + CHR(10) + CHR(13) + CHR(10)',
      '}',
    ].join('\r\n');
    const s = await saori('yaya', YAYA_WASM, 'saori/yayasaori/yaya.dll', {
      'saori/yayasaori/yaya.txt': new TextEncoder().encode('charset, UTF-8\r\ndic, saori.dic\r\n'),
      'saori/yayasaori/saori.dic': new TextEncoder().encode(dic),
    });
    expect(s.execute('engawa').result).toBe('ENGAWA');
  });
});

/** w×h の灰色の PNG */
function png(w: number, h: number): Uint8Array {
  const crc = (bytes: Uint8Array) => {
    let c = -1;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = new Uint8Array((w + 1) * h).map((_, i) => (i % (w + 1) === 0 ? 0 : 128));
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const written = (s: Awaited<ReturnType<typeof saori>>, path: string) =>
  s.y.effects.find((e): e is Extract<typeof e, { kind: 'write' }> => e.kind === 'write' && e.path === path)?.data;

describe('画像 (WebAssembly)', () => {
  it('saori-resized-png: 形式を調べ、縮めた PNG を書いてメインスレッドへ送る', async () => {
    const s = await saori('resizedpng', RESIZEDPNG_WASM, 'saori/resizedpng.dll', { 'img/in.png': png(8, 4) });
    expect(s.execute('GetImageType', '../img/in.png').result).toBe('PNG');
    expect(s.execute('ToResizedPng', '../img/in.png', '../img/out.png', '4', '-1').result).toBe('0');
    expect([...(written(s, 'ghost/master/img/out.png') ?? new Uint8Array(0)).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });

  it('saori-resized-png-mini: 大きさを調べる', async () => {
    const s = await saori('resizedpngmini', RESIZEDPNGMINI_WASM, 'saori/resizedpngmini.dll', { 'saori/in.png': png(8, 4) });
    expect(s.execute('GetImageInfo', 'in.png')).toMatchObject({ result: '0', values: ['8', '4'] });
  });

  it('saori-qrcode: アスキーアートと PNG', async () => {
    const s = await saori('qrcode', QRCODE_WASM, 'saori/saori_qrcode.dll');
    expect(s.execute('text', 'Engawa').raw).toContain('#');
    s.execute('image', 'Engawa', 'qr.png');
    expect([...(written(s, 'ghost/master/saori/qr.png') ?? new Uint8Array(0)).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });

  it('saori-pie-chart: 円グラフの PNG (文字の字体は無いので、文字は描かれない)', async () => {
    const s = await saori('piechart', PIECHART_WASM, 'saori/piechart.dll');
    const res = s.execute('chart.png', '100', '100', '40', '0', '0', '0', 'sans-serif', '12', '20', 'A', '0.25', 'red', 'B', '0.75', '#00f');
    expect(res.result).toBe('0');
    expect([...(written(s, 'ghost/master/saori/chart.png') ?? new Uint8Array(0)).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });
});
