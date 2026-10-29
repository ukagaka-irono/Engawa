import { describe, expect, it } from 'vitest';
import { sha1, totp } from '../src/saori/js/totp';
import { matchResponseCharset, parseSaoriRequest } from '../src/saori/protocol';
import { encodeCharset } from '../src/util/charset-encode';
import { openSaori } from './native-boot';

/** JavaScript で作り直した SAORI (src/saori/js/)。DLL の名前で見分けて作る */

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('SAORI/1.0 の要求と応答', () => {
  it('Charset に従って読み、抜けた Argument は空にする', () => {
    const req = parseSaoriRequest(encodeCharset('EXECUTE SAORI/1.0\r\nCharset: Shift_JIS\r\nArgument0: あ\r\nArgument2: う\r\n\r\n', 'Shift_JIS'));
    expect(req).toMatchObject({ method: 'EXECUTE', args: ['あ', '', 'う'], charset: 'Shift_JIS' });
  });

  it('要求と違う文字コードの応答は要求の文字コードに直し、末尾の NUL を除く', () => {
    const req = encodeCharset('EXECUTE SAORI/1.0\r\nCharset: Shift_JIS\r\n\r\n', 'Shift_JIS');
    const res = new TextEncoder().encode('SAORI/1.0 200 OK\r\nCharset: UTF-8\r\nResult: ①\r\n\r\n\0');
    expect(hex(matchResponseCharset(req, res))).toBe(hex(encodeCharset('SAORI/1.0 200 OK\r\nCharset: Shift_JIS\r\nResult: ①\r\n\r\n', 'Shift_JIS')));
  });
});

describe('クリップボード・音 (メインスレッドに頼む)', () => {
  it('textcopy2: Argument2 を改行にして写し、Argument1 が 0 なら 204', async () => {
    const s = await openSaori('textcopy2.dll');
    expect(s.execute('a|b', '0', '|').status).toBe(204);
    expect(s.y.effects).toEqual([{ kind: 'clipboard', text: 'a\r\nb' }]);
    expect(s.execute('').status).toBe(400);
  });

  it('clipcopy: Argument をすべて改行でつなぎ、「\\n」も改行にする', async () => {
    const s = await openSaori('saori/clipcopy.dll');
    expect(s.execute('1行目', '2\\n3').status).toBe(200);
    expect(s.y.effects).toEqual([{ kind: 'clipboard', text: '1行目\r\n2\r\n3' }]);
  });

  it('PlayWavSound: DLL からの相対パス (\\ 区切りも) の WAV を、中身ごと送る', async () => {
    const wav = Uint8Array.of(0x52, 0x49, 0x46, 0x46);
    const s = await openSaori('saori/PlayWavSound.dll', { 'sound/Hello.wav': wav });
    expect(s.execute('..\\sound\\hello.wav').result).toBe('1');
    expect(s.y.effects).toEqual([{ kind: 'sound', path: 'ghost/master/sound/Hello.wav', data: wav }]);
    expect(s.execute('system:SystemAsterisk').result).toBe('1');
    expect(s.y.effects).toHaveLength(1);
  });
});

describe('ブラウザから分かることだけを答える', () => {
  it('ccpuid: 問い合わせごとに Value、知らないものは !param error', async () => {
    const s = await openSaori('saori/ccpuid.dll');
    expect(s.execute('cpu.num', 'os.name', 'mem.phyt', 'cpu.sse2', 'nothing')).toMatchObject({
      status: 200,
      result: '8',
      values: ['8', 'Windows', '8192', 'Not Ready', '!param error'],
    });
    expect(s.execute('nothing').status).toBe(400);
  });

  it('window_info: Engawa のページだけを窓として答える', async () => {
    const s = await openSaori('saori/window_info.dll');
    expect(s.execute()).toMatchObject({ result: '1', values: ['Engawa'] });
    expect(s.execute('info', '0x1234').values.slice(1, 5)).toEqual(['Engawa', '0,0,1280,720', '0,0,1280,720', '0,0,1920,1040']);
  });

  it('advanced_sysinfo・GetDesktopInfo: 無いものは無いと答える', async () => {
    const a = await openSaori('saori/advanced_sysinfo.dll');
    expect(a.execute('get_special_folder_path', 'Desktop').status).toBe(204);
    expect(a.execute('expand_variable', '%HOME%').result).toBe('%HOME%');
    const d = await openSaori('saori/GetDesktopInfo.dll');
    expect(d.execute('query_trash')).toMatchObject({ result: '0', values: ['0', '0'] });
  });
});

describe('計算', () => {
  it('bignum: 任意の桁の四則演算と、誤差を決めた円周率・平方根', async () => {
    const s = await openSaori('saori/bignum.dll');
    expect(s.execute('+', '12345678901234567890', '98765432109876543210').result).toBe('111111111011111111100');
    expect(s.execute('*', '-1.5', '4').result).toBe('-6');
    // 小数第30位で丸め (…3832795 → …383280)、末尾の 0 は書かない
    expect(s.execute('pi', '1e-30', '0').result).toBe('3.14159265358979323846264338328');
    expect(s.execute('sqrt', '2', '1e-20').result).toBe('1.4142135623730950488');
    expect(s.execute('pi', '1e-3').status).toBe(400);
    expect(s.execute('+', 'x', '1').result).toBe('');
  });

  it('SHA-1・TOTP (RFC 3174・RFC 6238 の例)', () => {
    expect(hex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    const key = new TextEncoder().encode('12345678901234567890');
    expect(totp(key, 59, 8, 30)).toBe('94287082');
    expect(totp(key, 1111111109, 8, 30)).toBe('07081804');
    expect(totp(key, 20000000000, 8, 30)).toBe('65353130');
  });

  it('totp_saori: base32 の鍵', async () => {
    const s = await openSaori('saori/totp_saori.dll');
    expect(s.execute('totp', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '59', '8').result).toBe('94287082');
    expect(s.execute('keygen', '16').result).toMatch(/^[A-Z2-7]{16}$/);
  });

  it('KeywordReg: keyword.txt のキーワードを、カタカナ・ひらがなをそろえて探す', async () => {
    const keywords = encodeCharset('# 注釈\r\n果物＝りんご、ミカン\r\n天気=はれ,あめ\r\n', 'Shift_JIS');
    const s = await openSaori('saori/KeywordReg.dll', { 'saori/keyword.txt': keywords });
    expect(s.execute('GETKEYWORD', 'リンゴとみかん')).toMatchObject({ result: '果物', values: ['りんごとみかん'] });
    expect(s.execute('GETKEYWORD', '今日はハレ').result).toBe('天気');
  });
});
