import { describe, expect, it } from 'vitest';
import { encodeCharset } from '../src/util/charset-encode';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('encodeCharset (Shift_JIS)', () => {
  it('ASCII・かな・漢字・半角カナ', () => {
    expect(hex(encodeCharset('Aあ漢ｱ', 'Shift_JIS'))).toBe('41 82 a0 8a bf b1');
  });

  it('重複する符号は Encoding Standard と同じものを選ぶ', () => {
    expect(hex(encodeCharset('①', 'shift_jis'))).toBe('87 40'); // NEC 特殊文字
    expect(hex(encodeCharset('￢', 'shift_jis'))).toBe('81 ca'); // ￢ は JIS X 0208 の符号を優先
    expect(hex(encodeCharset('∵', 'shift_jis'))).toBe('81 e6');
    expect(hex(encodeCharset('ⅰ', 'shift_jis'))).toBe('fa 40'); // IBM 拡張を NEC 選定 IBM 拡張より優先
    expect(hex(encodeCharset('¥', 'shift_jis'))).toBe('5c');
  });

  it('表に無い文字は ?', () => {
    expect(hex(encodeCharset('😀é', 'Shift_JIS'))).toBe('3f 3f');
  });

  it('デコードすると元に戻る', () => {
    const text = 'さくらスクリプト\\0\\s[0]こんにちは。①ⅰ髙﨑～';
    expect(new TextDecoder('shift_jis').decode(encodeCharset(text, 'Shift_JIS'))).toBe(text);
  });

  it('UTF-8 はそのまま', () => {
    expect(hex(encodeCharset('あ', 'UTF-8'))).toBe('e3 81 82');
  });
});
