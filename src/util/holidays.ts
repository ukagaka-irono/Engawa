/**
 * 日本の祝日 (OnNotifyHolidayInfo)。「国民の祝日に関する法律」の今の決まりで計算する
 * (固定の日・ハッピーマンデー・春分と秋分・振替休日・国民の休日)。年ごとの特例 (五輪の年の移動など) は入れていない。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 春分の日・秋分の日 (1980〜2099 年の近似式) */
function equinox(year: number, autumn: boolean): number {
  const base = autumn ? 23.2488 : 20.8431;
  return Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その月の n 番目の月曜日 */
function nthMonday(year: number, month: number, n: number): number {
  const first = new Date(year, month - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

/** 振替・国民の休日を除いた、その年の祝日 (「月-日」→ 名前) */
function baseHolidays(year: number): Map<string, string> {
  const h = new Map<string, string>();
  const add = (m: number, d: number, name: string) => h.set(`${m}-${d}`, name);
  add(1, 1, '元日');
  add(1, nthMonday(year, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (year >= 2020) add(2, 23, '天皇誕生日');
  add(3, equinox(year, false), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthMonday(year, 7, 3), '海の日');
  add(8, 11, '山の日');
  add(9, nthMonday(year, 9, 3), '敬老の日');
  add(9, equinox(year, true), '秋分の日');
  add(10, nthMonday(year, 10, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  return h;
}

/** その日の祝日の名前。祝日でなければ undefined */
export function japaneseHoliday(date: Date): string | undefined {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const base = baseHolidays(y);
  const name = base.get(`${m}-${d}`);
  if (name) return name;
  const isBase = (t: Date) => t.getFullYear() === y && baseHolidays(t.getFullYear()).has(`${t.getMonth() + 1}-${t.getDate()}`);
  // 振替休日: 日曜の祝日から続く祝日の次の平日
  for (let back = 1; back <= 7; back++) {
    const t = new Date(y, m - 1, d - back);
    if (!isBase(t)) break;
    if (t.getDay() === 0) return '振替休日';
  }
  // 国民の休日: 前後の日が祝日の平日
  const prev = new Date(y, m - 1, d - 1);
  const next = new Date(y, m - 1, d + 1);
  if (date.getDay() !== 0 && isBase(prev) && isBase(next)) return '国民の休日';
  return undefined;
}

/** OnNotifyHolidayInfo の Reference (祝日でなければ undefined) */
export function holidayRefs(date = new Date()): string[] | undefined {
  const name = japaneseHoliday(date);
  return name ? [name, `${date.getFullYear()},${pad(date.getMonth() + 1)},${pad(date.getDate())}`, 'JP'] : undefined;
}
