import { describe, expect, it } from 'vitest';
import { readVersionInfo } from '../src/saori/js/misc';
import { openSaori } from './native-boot';

/** バージョン情報だけを持つ小さな PE (DLL) を作る (FileVersion の試し) */
function peWithVersion(version: [number, number, number, number], strings: Record<string, string>): Uint8Array {
  const u16 = (s: string) => {
    const out: number[] = [];
    for (const ch of s) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
    return [...out, 0, 0];
  };
  const pad = (a: number[]) => {
    while (a.length % 4) a.push(0);
    return a;
  };
  /** wLength, wValueLength, wType, szKey, (padding), Value, Children */
  const block = (key: string, value: number[], valueLen: number, type: number, children: number[] = []) => {
    const body = pad([0, 0, valueLen & 0xff, valueLen >> 8, type, 0, ...u16(key)]);
    body.push(...pad([...value]), ...children);
    body[0] = body.length & 0xff;
    body[1] = body.length >> 8;
    return pad(body);
  };
  const [a, b, c, d] = version;
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const fixed = [...le32(0xfeef04bd), ...le32(0x10000), ...le32((a << 16) | b), ...le32((c << 16) | d), ...le32((a << 16) | b), ...le32((c << 16) | d), ...new Array(32).fill(0)];
  const entries = Object.entries(strings).flatMap(([k, v]) => block(k, u16(v), v.length + 1, 1));
  const table = block('041104b0', [], 0, 1, entries);
  const sfi = block('StringFileInfo', [], 0, 1, table);
  const info = block('VS_VERSION_INFO', fixed, fixed.length, 0, sfi);
  // ヘッダ (0x200) と .rsrc セクション (RVA 0x1000、ファイルの 0x200)
  const rsrc: number[] = [];
  const dir = (count: number) => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, count, 0];
  // type 16 → name 1 → lang 0x411 → data entry
  rsrc.push(...dir(1), ...le32(16), ...le32(0x80000000 | 24));
  rsrc.push(...dir(1), ...le32(1), ...le32(0x80000000 | 48));
  rsrc.push(...dir(1), ...le32(0x411), ...le32(72));
  rsrc.push(...le32(0x1000 + 88), ...le32(info.length), 0, 0, 0, 0, 0, 0, 0, 0);
  rsrc.push(...info);
  const file = new Uint8Array(0x200 + rsrc.length);
  const dv = new DataView(file.buffer);
  dv.setUint16(0, 0x5a4d, true);
  dv.setUint32(0x3c, 0x80, true);
  dv.setUint32(0x80, 0x4550, true);
  dv.setUint16(0x86, 1, true); // セクションの数
  dv.setUint16(0x94, 224, true); // オプションヘッダの大きさ
  dv.setUint16(0x98, 0x10b, true);
  dv.setUint32(0x98 + 96 + 16, 0x1000, true); // リソースの RVA
  const sec = 0x98 + 224;
  file.set(new TextEncoder().encode('.rsrc'), sec);
  dv.setUint32(sec + 8, rsrc.length, true);
  dv.setUint32(sec + 12, 0x1000, true);
  dv.setUint32(sec + 16, rsrc.length, true);
  dv.setUint32(sec + 20, 0x200, true);
  file.set(rsrc, 0x200);
  return file;
}

describe('JavaScript で作り直した SAORI (つづき)', () => {
  it('FileVersion はゴーストの中の DLL のバージョン情報を読む', async () => {
    const dll = peWithVersion([1, 2, 3, 4], { ProductName: '製品', FileDescription: '説明', LegalCopyright: '(C) 誰か' });
    expect(readVersionInfo(dll)?.version).toBe('1.2.3.4');
    const s = await openSaori('FileVersion.dll', { 'target.dll': dll, 'plain.txt': new Uint8Array([1, 2, 3]) });
    expect(s.execute('target.dll')).toMatchObject({ status: 200, result: '1.2.3.4', values: ['製品', '説明', '', '(C) 誰か', ''] });
    expect(s.execute('plain.txt').result).toBe('ERROR_NORESOURCE');
    expect(s.execute('none.dll').result).toBe('ERROR_OPEN');
  });

  it('nullsaori・SaoriTest・MakotoUtil', async () => {
    expect((await openSaori('nullsaori.dll')).execute('x').status).toBe(200);
    expect((await openSaori('saori/SaoriTest.dll')).execute('a', 'b').result).toBe('\\ghost\\master\\saori\\ab');
    const m = await openSaori('MakotoUtil.dll');
    expect(m.execute('keydown', '13').result).toBe('0');
    expect(m.execute('inputbox', '名前は？', '題', '初期値').result).toBe('初期値');
    expect(m.execute('messagebox', 'はい').result).toBe('1');
  });

  it('AqTalkSaori は音声合成をページに頼む', async () => {
    const s = await openSaori('AqTalkSaori.dll');
    expect(s.execute('PLAYASYNC', 'こんにちわ').result).toBe('');
    expect(s.execute('STOP').result).toBe('');
    expect(s.execute('PLAYSYNC').result).toMatch(/^ERROR002/);
    expect(s.y.effects).toEqual([{ kind: 'speak', text: 'こんにちわ', rate: undefined }, { kind: 'speak', text: '', stop: true }]);
  });

  it('chttpc は file: のファイルを読み、タグを外したりさくらスクリプトにしたりする', async () => {
    const html = new TextEncoder().encode('<html><head><title>t</title></head><body><p>こんにちは<br><a href="https://example.com/a">リンク</a></p><script>x</script></body></html>');
    const s = await openSaori('chttpc.dll', { 'page.html': html });
    expect(s.execute('file:page.html', 'strip').result).toBe('tこんにちはリンク');
    expect(s.execute('file:page.html', 'translate').result).toBe('\\n[half]こんにちは\\n\\_a[https://example.com/a]リンク\\_a\\n');
    expect(s.execute('file:page.html', 'start=<p>', 'end=<br>').result).toBe('こんにちは');
  });

  it('ブラウザでは行えない SAORI は、できなかったときの答えを返す', async () => {
    expect((await openSaori('SetCursorPos.dll')).execute('100', '100').status).toBe(204);
    expect((await openSaori('screenshot.dll')).execute('shot.png').status).toBe(500);
    expect((await openSaori('proxy_ex.dll')).execute('foo.exe').status).toBe(200);
  });

  it('ninix-saori はゴーストに無くても名前で開ける', async () => {
    const s = await openSaori('saori/example.dll');
    expect(s.execute('こんにちは')).toMatchObject({ result: 'This is example.', values: ['こんにちは'] });
    expect((await openSaori('saori_call_translator.dll')).execute('result').result).toBe('-1');
  });
});
