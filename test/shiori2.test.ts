import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/shiori/protocol';
import { fromShiori2, toShiori2 } from '../src/shiori/shiori2';

const lines = (text: string | undefined) => text?.split('\r\n').filter(Boolean);

describe('SHIORI/2.x への読み替え', () => {
  it('イベントは GET Sentence (Event と Reference)', () => {
    const r = toShiori2(buildRequest({ method: 'GET', id: 'OnMouseDoubleClick', references: [10, 20, 0, 0, 'Head'] }));
    expect(lines(r?.text)).toEqual([
      'GET Sentence SHIORI/2.2',
      'Sender: Engawa',
      'Charset: UTF-8',
      'SecurityLevel: local',
      'Event: OnMouseDoubleClick',
      'Reference0: 10',
      'Reference1: 20',
      'Reference2: 0',
      'Reference3: 0',
      'Reference4: Head',
    ]);
    expect(fromShiori2('SHIORI/2.2 200 OK\r\nSender: kawari\r\nSentence: \\0\\s0はい。\\e\r\nCharset: Shift_JIS\r\n\r\n', r!)).toBe(
      'SHIORI/3.0 200 OK\r\nSender: kawari\r\nCharset: Shift_JIS\r\nValue: \\0\\s0はい。\\e\r\n\r\n',
    );
  });

  it('OnCommunicate は話しかけた相手と文、Reference2 以降を Reference0 以降にする', () => {
    const r = toShiori2(buildRequest({ method: 'GET', id: 'OnCommunicate', references: ['user', 'こんにちは', 'extra'] }));
    expect(lines(r?.text)).toEqual([
      'GET Sentence SHIORI/2.3',
      'Charset: UTF-8',
      'SecurityLevel: local',
      'Sender: User',
      'Sentence: こんにちは',
      'Reference0: extra',
    ]);
  });

  it('文字列リソースは GET String、version は GET Version', () => {
    const s = toShiori2(buildRequest({ method: 'GET', id: 'sakura.recommendsites' }));
    expect(lines(s?.text)?.[0]).toBe('GET String SHIORI/2.5');
    expect(lines(s?.text)).toContain('ID: sakura.recommendsites');
    expect(fromShiori2('SHIORI/2.5 200 OK\r\nString: a\x01http://example.com/\r\n\r\n', s!)).toContain('Value: a\x01http://example.com/');
    const v = toShiori2(buildRequest({ method: 'GET', id: 'version' }));
    expect(lines(v?.text)?.[0]).toBe('GET Version SHIORI/2.0');
    expect(fromShiori2('SHIORI/2.0 200 OK\r\nID: KAWARI\r\nCraftman: team\r\nVersion: 7.3.1\r\n\r\n', v!)).toBe('SHIORI/3.0 200 OK\r\nValue: 7.3.1\r\n\r\n');
  });

  it('NOTIFY は OwnerGhostName と OtherGhostName だけを送る', () => {
    const owner = toShiori2(buildRequest({ method: 'NOTIFY', id: 'ownerghostname', references: ['さくら'] }));
    expect(lines(owner?.text)).toContain('Ghost: さくら');
    expect(lines(owner?.text)?.[0]).toBe('NOTIFY OwnerGhostName SHIORI/2.0');
    const others = toShiori2(buildRequest({ method: 'NOTIFY', id: 'otherghostname', references: ['なる\x010\x0110', 'まゆら\x010\x0110'] }));
    expect(lines(others?.text)?.filter((l) => l.startsWith('GhostEx: '))).toEqual(['GhostEx: なる\x010\x0110', 'GhostEx: まゆら\x010\x0110']);
    expect(toShiori2(buildRequest({ method: 'NOTIFY', id: 'basewareversion', references: ['1.0'] }))).toBeUndefined();
  });

  it('Sentence の無い 200 は 204 にする', () => {
    const r = toShiori2(buildRequest({ method: 'GET', id: 'OnSecondChange' }))!;
    expect(fromShiori2('SHIORI/2.2 200 OK\r\nSender: kawari\r\n\r\n', r).split('\r\n')[0]).toBe('SHIORI/3.0 204 No Content');
  });
});
