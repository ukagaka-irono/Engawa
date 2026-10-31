import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/sakura/tokenizer';

const tags = (s: string) => tokenize(s).map((t) => (t.type === 'tag' ? [t.name, t.args] : [t.type, t.type === 'text' ? t.text : t.name]));

describe('tokenize', () => {
  it('splits scopes, surfaces and text', () => {
    expect(tags('\\0\\s[5]こんにちは\\1\\s10\\e')).toEqual([
      ['0', []],
      ['s', ['5']],
      ['text', 'こんにちは'],
      ['1', []],
      ['s', ['1']],
      ['text', '0'],
      ['e', []],
    ]);
  });

  it('parses underscored tags and waits', () => {
    expect(tags('\\_q\\w9\\_w[300]\\__w[1000]')).toEqual([
      ['_q', []],
      ['w', ['9']],
      ['_w', ['300']],
      ['__w', ['1000']],
    ]);
  });

  it('handles quoted bracket arguments and escaped brackets', () => {
    expect(tags('\\q["a,b",id]\\![raise,OnX,"x]y"]\\q[a\\]b,c]')).toEqual([
      ['q', ['a,b', 'id']],
      ['!', ['raise', 'OnX', 'x]y']],
      ['q', ['a]b', 'c']],
    ]);
  });

  it('converts old choice forms to [title, id] and breaks the line after each', () => {
    expect(tags('\\q0[OnYes][はい]\\q[OnNo][いいえ]\\q10[a][A]')).toEqual([
      ['q', ['はい', 'OnYes']],
      ['n', []],
      ['q', ['いいえ', 'OnNo']],
      ['n', []],
      ['q', ['A', 'a']],
      ['n', []],
    ]);
  });

  it('keeps the new choice form when the first bracket has a title and an id', () => {
    expect(tags('\\q[はい,yes][注]')).toEqual([
      ['q', ['はい', 'yes']],
      ['text', '[注]'],
    ]);
  });

  it('accepts half and percentage line feeds, and treats other \\n[ as text', () => {
    expect(tags('\\n[half]\\n[150]\\n[-100]\\n[注意]')).toEqual([
      ['n', ['half']],
      ['n', ['150']],
      ['n', ['-100']],
      ['n', []],
      ['text', '[注意]'],
    ]);
  });

  it('shows \\_? sections as text without running the tags inside', () => {
    expect(tags('パス: \\_?C:\\temp\\new.txt\\-\\_?\\e')).toEqual([
      ['text', 'パス: C:\\temp\\new.txt\\-'],
      ['e', []],
    ]);
  });

  it('unescapes \\\\ and \\% and finds env variables', () => {
    expect(tags('a\\\\b\\%c%username%property[baseware.name]')).toEqual([
      ['text', 'a\\b%c'],
      ['env', 'username'],
      ['env', 'property:baseware.name'],
    ]);
  });

  it('ignores raw newlines in scripts', () => {
    expect(tags('a\r\nb')).toEqual([['text', 'ab']]);
  });

  it('reads %lastobjectname and %* (ukadoc の環境変数)', () => {
    expect(tags('%lastobjectname%*x')).toEqual([
      ['env', 'lastobjectname'],
      ['env', '*'],
      ['text', 'x'],
    ]);
  });
});
