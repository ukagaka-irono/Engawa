import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarRefs, parseICal, today } from '../src/ghost/ical';
import { networkUpdate, updateResultRefs } from '../src/package/update';
import { japaneseHoliday } from '../src/util/holidays';
import { md5 } from '../src/util/md5';
import { FileTree } from '../src/vfs/files';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('iCalendar (\\![execute,ical-get])', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:テスト',
    'X-WR-TIMEZONE:Asia/Tokyo',
    'BEGIN:VEVENT',
    'UID:weekly',
    'DTSTART:20260907T093000',
    'DTEND:20260907T100000',
    'SUMMARY:朝会 100%',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    'BEGIN:VALARM',
    'SUMMARY:通知',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:camp',
    'DTSTART;VALUE=DATE:20260910',
    'DTEND;VALUE=DATE:20260912',
    'SUMMARY:合宿',
    'DESCRIPTION:持ち物\\n寝袋',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:nosummary',
    'DTSTART:20260901',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('予定を読み、終日の予定の終わりは1日戻す。SUMMARY の無い予定は除く', () => {
    const cal = parseICal(ics)!;
    expect(cal.name).toBe('テスト');
    expect(cal.events.map((e) => e.uid)).toEqual(['weekly', 'camp']);
    expect(cal.events[1].end).toEqual({ y: 2026, m: 9, d: 11 });
    const refs = calendarRefs(cal, {});
    expect(refs[0].split('\x01').slice(0, 5)).toEqual(['テスト', 'Asia/Tokyo', 'GREGORIAN', '2', '2']);
    const camp = refs[2].split('\x01');
    expect(camp.slice(0, 5)).toEqual(['camp', '2026,9,10,,,', '2026,9,11,,,', '合宿', '持ち物 寝袋']);
    // % はさくらスクリプトとして読まれないように
    expect(refs[1].split('\x01')[3]).toBe('朝会 100\\%');
  });

  it('--expand で繰り返しを1回ずつ展開する (COUNT まで)', () => {
    const cal = parseICal(ics)!;
    const from = today(new Date(2026, 8, 1));
    const refs = calendarRefs(cal, { from: '20260901', to: '20260930', expand: '' }, from);
    const rows = refs.slice(1).map((r) => r.split('\x01'));
    expect(rows.map((r) => `${r[0]}@${r[11]}`)).toEqual(['weekly@2026,9,7,,,', 'camp@2026,9,10,,,', 'camp@2026,9,11,,,', 'weekly@2026,9,14,,,', 'weekly@2026,9,21,,,']);
    expect(rows[3][1]).toBe('2026,9,14,9,30,0');
  });
});

describe('日本の祝日 (OnNotifyHolidayInfo)', () => {
  it('固定の日・ハッピーマンデー・春分・振替休日・国民の休日', () => {
    expect(japaneseHoliday(new Date(2026, 0, 1))).toBe('元日');
    expect(japaneseHoliday(new Date(2026, 0, 12))).toBe('成人の日');
    expect(japaneseHoliday(new Date(2026, 2, 20))).toBe('春分の日');
    expect(japaneseHoliday(new Date(2026, 4, 6))).toBe('振替休日');
    expect(japaneseHoliday(new Date(2026, 8, 22))).toBe('国民の休日');
    expect(japaneseHoliday(new Date(2026, 8, 24))).toBeUndefined();
  });
});

describe('ネットワーク更新 (シェル・バルーン、delete.txt、結果のまとめ)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ゴースト以外は OnUpdateOther… を送り、delete.txt のファイルを消す', async () => {
    const newer = bytes('新しい');
    const del = bytes('old.png\r\nold\\\r\n');
    const list = bytes(`surface0.png\x01${md5(newer)}\x01\r\ndelete.txt\x01${md5(del)}\x01\r\n`);
    const server: Record<string, Uint8Array> = { 'updates2.dau': list, 'surface0.png': newer, 'delete.txt': del };
    vi.stubGlobal('fetch', async (url: string) => {
      const name = decodeURIComponent(url.split('/').pop()!);
      const body = server[name];
      return body ? new Response(body as BodyInit) : new Response('', { status: 404 });
    });
    const files = new FileTree([
      ['surface0.png', bytes('古い')],
      ['old.png', bytes('x')],
      ['old/a.png', bytes('x')],
    ]);
    const events: string[] = [];
    const removed: string[][] = [];
    const res = await networkUpdate(
      'https://example.com/shell/',
      files,
      { raise: async (id) => void events.push(id), write: async () => {}, remove: async (paths) => void removed.push(paths) },
      { target: 'shell', reason: 'script', other: true, ghostName: 'G', path: 'ghost/g' },
    );
    expect(res).toMatchObject({ ok: true, changed: ['surface0.png', 'delete.txt'] });
    expect(events[0]).toBe('OnUpdateOtherBegin');
    expect(events).toContain('OnUpdateOther.OnDownloadBegin');
    expect(events.at(-1)).toBe('OnUpdateOtherComplete');
    expect(removed).toEqual([['old.png', 'old/']]);
    expect(files.has('old.png')).toBe(false);
    expect(files.has('old/a.png')).toBe(false);
    expect(updateResultRefs([{ name: 'マスター', target: 'shell', result: res }], true)).toEqual(['マスター\x01shell\x01OK\x012']);
    expect(updateResultRefs([{ name: 'x', target: 'ghost', result: { ok: false, changed: [], reason: 'md5 miss', file: 'a.dic' } }], false)).toEqual(['ghost\x01NG\x01md5 miss\x01a.dic']);
  });

  it('delete.txt にフォルダが書かれていても、更新の一覧にあるファイル (今回取ってきたもの) は消さない', async () => {
    const fresh = bytes('新しい辞書');
    const del = bytes('dic\\\r\n');
    const list = bytes(`dic/new.dic\x01${md5(fresh)}\x01\r\ndelete.txt\x01${md5(del)}\x01\r\n`);
    const server: Record<string, Uint8Array> = { 'updates2.dau': list, 'new.dic': fresh, 'delete.txt': del };
    vi.stubGlobal('fetch', async (url: string) => {
      const body = server[decodeURIComponent(url.split('/').pop()!)];
      return body ? new Response(body as BodyInit) : new Response('', { status: 404 });
    });
    const files = new FileTree([['dic/old.dic', bytes('古い')]]);
    const removed: [string[], string[]][] = [];
    await networkUpdate(
      'https://example.com/',
      files,
      { raise: async () => {}, write: async () => {}, remove: async (paths, keep) => void removed.push([paths, keep]) },
      { target: 'ghost', reason: 'manual', ghostName: 'G', path: 'ghost/g' },
    );
    expect(removed).toEqual([[['dic/'], ['dic/new.dic', 'delete.txt']]]);
    expect(files.has('dic/old.dic')).toBe(false);
    expect(files.get('dic/new.dic')).toEqual(fresh);
  });

  it('testonly は取ってくるが置き換えない', async () => {
    const newer = bytes('新しい');
    vi.stubGlobal('fetch', async (url: string) => new Response((url.endsWith('updates2.dau') ? bytes(`a.txt\x01${md5(newer)}\x01\r\n`) : newer) as BodyInit));
    const writes: string[] = [];
    const res = await networkUpdate('https://example.com/', new FileTree([['a.txt', bytes('古い')]]), { raise: async () => {}, write: async (p) => void writes.push(p) }, { target: 'ghost', reason: 'manual', testOnly: true, ghostName: 'G', path: 'ghost/g' });
    expect(res.changed).toEqual(['a.txt']);
    expect(writes).toEqual([]);
  });
});
