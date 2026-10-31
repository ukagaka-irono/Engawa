/**
 * iCalendar (RFC 5545) を読み、\![execute,ical-get]・\![execute,schedule-get] の結果 (OnExecuteICalComplete の Reference) にする。
 * 繰り返し (RRULE) は FREQ・INTERVAL・COUNT・UNTIL・BYDAY・BYMONTHDAY・BYMONTH と EXDATE を解く (ukadoc の「iCal絞り込みオプション」)。
 */

export interface CalDate {
  y: number;
  m: number;
  d: number;
  /** 終日なら undefined */
  time?: { h: number; mi: number; s: number };
}

export interface CalEvent {
  uid: string;
  start: CalDate;
  /** 最終日 (DTEND は排他なので1日戻したもの)。無ければ開始と同じ日 */
  end: CalDate;
  summary: string;
  description: string;
  location: string;
  url: string;
  status: string;
  categories: string;
  rrule: string;
  exdates: string[];
}

export interface Calendar {
  name: string;
  timezone: string;
  calscale: string;
  events: CalEvent[];
}

/** 折り返された行をつなぎ、「名前;引数:値」に分ける */
function lines(text: string): { name: string; params: string; value: string }[] {
  const raw = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  for (const l of raw) {
    const colon = l.indexOf(':');
    if (colon < 0) continue;
    const head = l.slice(0, colon);
    const semi = head.indexOf(';');
    out.push({ name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(), params: semi < 0 ? '' : head.slice(semi + 1), value: l.slice(colon + 1) });
  }
  return out;
}

const unescape = (v: string) => v.replace(/\\([nN])/g, '\n').replace(/\\([,;\\])/g, '$1');

/** 20260910 / 20260910T093000(Z) を日付に (Z は手元の時刻に直す) */
export function parseCalDate(v: string): CalDate | undefined {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?(Z?))?/.exec(v.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return { y, m: mo, d };
  if (m[7] === 'Z') {
    const t = new Date(Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), time: { h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() } };
  }
  return { y, m: mo, d, time: { h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) } };
}

const dayNumber = (c: CalDate) => Math.floor(Date.UTC(c.y, c.m - 1, c.d) / 86_400_000);
const fromDay = (n: number): CalDate => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** DURATION (P1D・PT1H30M など) の日数と秒数 */
function duration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const sec = (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return m[1] === '-' ? -sec : sec;
}

export function parseICal(text: string): Calendar | undefined {
  if (!/BEGIN:VCALENDAR/i.test(text)) return undefined;
  const cal: Calendar = { name: '', timezone: '', calscale: 'GREGORIAN', events: [] };
  let ev: Partial<CalEvent> & { dtend?: CalDate; dur?: number } = {};
  let inEvent = false;
  let depth = 0;
  for (const { name, params, value } of lines(text)) {
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') {
      inEvent = true;
      depth = 0;
      ev = { exdates: [] };
      continue;
    }
    if (inEvent && name === 'BEGIN') depth++;
    if (inEvent && name === 'END') {
      if (value.toUpperCase() !== 'VEVENT') {
        depth--;
        continue;
      }
      inEvent = false;
      if (!ev.summary || !ev.start) continue;
      let end = ev.start;
      if (ev.dtend) end = ev.start.time ? ev.dtend : fromDay(dayNumber(ev.dtend) - 1);
      else if (ev.dur) {
        const t = new Date(ev.start.y, ev.start.m - 1, ev.start.d, ev.start.time?.h ?? 0, ev.start.time?.mi ?? 0, (ev.start.time?.s ?? 0) + ev.dur);
        end = ev.start.time ? { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), time: { h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() } } : fromDay(dayNumber(ev.start) + Math.max(0, Math.ceil(ev.dur / 86400) - 1));
      }
      if (!ev.start.time && end.time) end = { y: end.y, m: end.m, d: end.d };
      cal.events.push({
        uid: ev.uid ?? '',
        start: ev.start,
        end: dayNumber(end) < dayNumber(ev.start) ? ev.start : end,
        summary: ev.summary,
        description: ev.description ?? '',
        location: ev.location ?? '',
        url: ev.url ?? '',
        status: ev.status ?? '',
        categories: ev.categories ?? '',
        rrule: ev.rrule ?? '',
        exdates: ev.exdates ?? [],
      });
      continue;
    }
    if (!inEvent) {
      if (name === 'X-WR-CALNAME') cal.name = unescape(value);
      else if (name === 'X-WR-TIMEZONE') cal.timezone = value;
      else if (name === 'CALSCALE') cal.calscale = value;
      continue;
    }
    if (depth > 0) continue; // VALARM の中
    switch (name) {
      case 'UID':
        ev.uid = value;
        break;
      case 'DTSTART':
        ev.start = parseCalDate(value);
        break;
      case 'DTEND':
        ev.dtend = parseCalDate(value);
        break;
      case 'DURATION':
        ev.dur = duration(value);
        break;
      case 'SUMMARY':
        ev.summary = unescape(value);
        break;
      case 'DESCRIPTION':
        ev.description = unescape(value);
        break;
      case 'LOCATION':
        ev.location = unescape(value);
        break;
      case 'URL':
        ev.url = value;
        break;
      case 'STATUS':
        ev.status = value;
        break;
      case 'CATEGORIES':
        ev.categories = unescape(value);
        break;
      case 'RRULE':
        ev.rrule = value;
        break;
      case 'EXDATE':
        for (const d of value.split(',')) {
          const c = parseCalDate(d);
          if (c) ev.exdates!.push(String(dayNumber(c)));
        }
        break;
    }
    void params;
  }
  return cal;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** 予定が from〜to の日 (日の番号) のうち、どの日に始まるか (繰り返しを解く) */
export function occurrences(ev: CalEvent, from: number, to: number, max = 5000): number[] {
  const start = dayNumber(ev.start);
  const exdates = new Set(ev.exdates.map(Number));
  const out: number[] = [];
  const push = (d: number) => {
    if (d >= start && !exdates.has(d)) out.push(d);
  };
  if (!ev.rrule) {
    push(start);
    return out.filter((d) => d <= to && d + (dayNumber(ev.end) - start) >= from);
  }
  const rule = new Map(ev.rrule.split(';').map((p) => p.split('=') as [string, string]).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const freq = rule.get('FREQ') ?? 'DAILY';
  const interval = Math.max(1, Number(rule.get('INTERVAL')) || 1);
  const count = Number(rule.get('COUNT')) || 0;
  const until = rule.get('UNTIL') ? parseCalDate(rule.get('UNTIL')!) : undefined;
  const untilDay = until ? dayNumber(until) : Infinity;
  const byDay = (rule.get('BYDAY') ?? '').split(',').filter(Boolean).map((s) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s)).filter((m): m is RegExpExecArray => !!m);
  const byMonthDay = (rule.get('BYMONTHDAY') ?? '').split(',').filter(Boolean).map(Number);
  const byMonth = (rule.get('BYMONTH') ?? '').split(',').filter(Boolean).map(Number);
  let n = 0;
  const last = Math.min(to, untilDay);
  // 1日ずつ見て、規則に合う日を数える (最大 1830 日 + 開始から)
  for (let d = start; d <= last && out.length < max; d++) {
    const c = fromDay(d);
    const wd = new Date(d * 86_400_000).getUTCDay();
    const sc = ev.start;
    let match: boolean;
    if (freq === 'DAILY') match = (d - start) % interval === 0;
    else if (freq === 'WEEKLY') {
      const week = Math.floor((d - start + ((new Date(start * 86_400_000).getUTCDay() + 6) % 7)) / 7);
      match = week % interval === 0 && (byDay.length ? byDay.some((m) => WEEKDAYS.indexOf(m[2]) === wd) : wd === new Date(start * 86_400_000).getUTCDay());
    } else if (freq === 'MONTHLY') {
      const months = (c.y - sc.y) * 12 + (c.m - sc.m);
      const days = new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
      const nth = Math.floor((c.d - 1) / 7) + 1;
      const fromEnd = -(Math.floor((days - c.d) / 7) + 1);
      match =
        months % interval === 0 &&
        (byMonthDay.length
          ? byMonthDay.some((x) => x === c.d || (x < 0 && days + x + 1 === c.d))
          : byDay.length
            ? byDay.some((m) => WEEKDAYS.indexOf(m[2]) === wd && (!m[1] || Number(m[1]) === nth || Number(m[1]) === fromEnd))
            : c.d === sc.d);
    } else {
      const years = c.y - sc.y;
      match = years % interval === 0 && (byMonth.length ? byMonth.includes(c.m) : c.m === sc.m) && (byMonthDay.length ? byMonthDay.includes(c.d) : c.d === sc.d);
    }
    if (match && byMonth.length && freq !== 'YEARLY') match = byMonth.includes(c.m);
    if (!match) continue;
    n++;
    if (count && n > count) break;
    if (d >= from - (dayNumber(ev.end) - start)) push(d);
  }
  return out;
}

const pad = (s: CalDate | undefined, allDay: boolean) => (s ? [s.y, s.m, s.d, ...(allDay || !s.time ? ['', '', ''] : [s.time.h, s.time.mi, s.time.s])].join(',') : '');
/** さくらスクリプトとして読まれないように (\ と % と改行・タブ) */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/[\r\n\t]+/g, ' ');

export interface CalFilter {
  from?: string;
  to?: string;
  /** 展開する日数 ('' は30日) */
  expand?: string;
  limit?: string;
}

/** 今日 (手元の日付) の日の番号 */
export function today(now = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}

/** OnExecuteICalComplete の Reference (Reference0 がカレンダー全体、1 以降が予定) */
export function calendarRefs(cal: Calendar, f: CalFilter, now = today()): string[] {
  const periodMode = f.from !== undefined || f.to !== undefined || f.expand !== undefined || f.limit !== undefined;
  const rows: { ev: CalEvent; day?: number; occ?: number }[] = [];
  let from = now;
  let to = now;
  if (!periodMode) {
    for (const ev of cal.events) rows.push({ ev });
  } else {
    const fromDate = f.from ? parseCalDate(f.from) : undefined;
    from = fromDate ? dayNumber(fromDate) : now;
    const toDate = f.to ? parseCalDate(f.to) : undefined;
    const days = f.expand !== undefined ? Number(f.expand) || 30 : 1830;
    to = toDate ? dayNumber(toDate) : from + days - 1;
    to = Math.min(to, from + 1829);
    const limit = f.limit === undefined ? 200 : Number(f.limit) || 0;
    // 何日にもわたる予定は、そのすべての日を「発生日」とする
    const coveredDays = (ev: CalEvent, max?: number) => {
      const span = dayNumber(ev.end) - dayNumber(ev.start);
      const out: { day: number; occ: number }[] = [];
      for (const d of occurrences(ev, from, to, max)) for (let k = 0; k <= span; k++) if (d + k >= from && d + k <= to) out.push({ day: d + k, occ: d });
      return out;
    };
    if (f.expand !== undefined) {
      for (const ev of cal.events) for (const d of coveredDays(ev)) rows.push({ ev, ...d });
      rows.sort((a, b) => a.day! - b.day!);
    } else {
      for (const ev of cal.events) {
        const first = coveredDays(ev, 1)[0];
        if (first !== undefined) rows.push({ ev, ...first });
      }
      rows.sort((a, b) => a.day! - b.day! || (a.ev.start.time ? a.ev.start.time.h * 60 + a.ev.start.time.mi : -1) - (b.ev.start.time ? b.ev.start.time.h * 60 + b.ev.start.time.mi : -1));
    }
    if (limit > 0) rows.splice(limit);
  }
  const head = [esc(cal.name), cal.timezone, cal.calscale, rows.length, cal.events.length, periodMode ? pad(fromDay(from), true) : '', periodMode ? pad(fromDay(Math.max(from - 1, to)), true) : ''].join('\x01');
  return [
    head,
    ...rows.map(({ ev, day, occ }) => {
      const allDay = !ev.start.time;
      // 繰り返しの回は、開始・終了をその日に合わせる
      const shift = occ !== undefined ? occ - dayNumber(ev.start) : 0;
      const start = shift ? { ...fromDay(dayNumber(ev.start) + shift), time: ev.start.time } : ev.start;
      const end = shift ? { ...fromDay(dayNumber(ev.end) + shift), time: ev.end.time } : ev.end;
      return [ev.uid, pad(start, allDay), pad(end, allDay), esc(ev.summary), esc(ev.description), esc(ev.location), esc(ev.url), ev.status, esc(ev.categories), ev.rrule, allDay ? 1 : 0, day !== undefined ? pad(fromDay(day), true) : ''].join('\x01');
    }),
  ];
}

/** 予定1件を iCalendar の VEVENT にする (ゴースト用の予定表に保存する) */
export function eventToICal(ev: CalEvent): string {
  const date = (c: CalDate) => `${String(c.y).padStart(4, '0')}${String(c.m).padStart(2, '0')}${String(c.d).padStart(2, '0')}${c.time ? `T${[c.time.h, c.time.mi, c.time.s].map((v) => String(v).padStart(2, '0')).join('')}` : ''}`;
  const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const endEx = ev.start.time ? ev.end : fromDay(dayNumber(ev.end) + 1);
  const lines = ['BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTART${ev.start.time ? '' : ';VALUE=DATE'}:${date(ev.start)}`, `DTEND${ev.start.time ? '' : ';VALUE=DATE'}:${date(endEx)}`, `SUMMARY:${text(ev.summary)}`];
  if (ev.description) lines.push(`DESCRIPTION:${text(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${text(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.status) lines.push(`STATUS:${ev.status}`);
  if (ev.categories) lines.push(`CATEGORIES:${ev.categories}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
  if (ev.exdates.length) lines.push(`EXDATE;VALUE=DATE:${ev.exdates.map((d) => date(fromDay(Number(d)))).join(',')}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

export function calendarToICal(events: CalEvent[], name: string): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Engawa//ghost schedule//JA', `X-WR-CALNAME:${name}`, ...events.map(eventToICal), 'END:VCALENDAR', ''].join('\r\n');
}

/** schedule-add の --start などの日時 (yyyymmdd / yyyymmddThhmm(ss)。- と : は無視) */
export function parseScheduleDate(v: string): CalDate | undefined {
  return parseCalDate(v.replace(/[-:]/g, ''));
}
