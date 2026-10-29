/** さくらスクリプトの字句解析。 */

export type Token =
  | { type: 'text'; text: string }
  | { type: 'tag'; name: string; args: string[]; raw: string }
  | { type: 'env'; name: string; raw: string };

/** 1文字の数字を角括弧なしで取れるタグ (\s0 \w5 \b2 \i1 \p2) */
const SHORT_DIGIT = new Set(['s', 'w', 'b', 'i', 'p']);

/** 角括弧の引数を取るタグ。これ以外は直後の [ を本文として扱う。 */
const BRACKET = new Set([
  's', 'b', 'i', 'p', 'q', 'n', 'c', 'x', 'f', 'j', '!', '&', '8',
  '_w', '__w', '_a', '_b', '_l', '_u', '_m', '_v', '_s', '__q', '_n',
]);

/** %変数 (長いものから照合する) */
const ENV_NAMES = [
  'screenheight', 'screenwidth', 'lastghostname', 'selfname2', 'selfname', 'keroname', 'username',
  'wronghour', 'minute', 'second', 'month', 'hour', 'day', 'exh', 'et', 'ms', 'mz', 'ml', 'mc', 'mh', 'mt', 'me', 'mp', 'm?', 'dms',
];

function parseBracket(s: string, start: number): { args: string[]; end: number } {
  const args: string[] = [];
  let cur = '';
  let quoted = false;
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cur += c;
      }
      i++;
      continue;
    }
    if (c === '\\' && (s[i + 1] === ']' || s[i + 1] === '[')) {
      cur += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
      i++;
      continue;
    }
    if (c === ',') {
      args.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ']') {
      args.push(cur);
      return { args, end: i + 1 };
    }
    cur += c;
    i++;
  }
  args.push(cur);
  return { args, end: i };
}

/** \n[half] / \n[150] / \n[-100] (パーセント。負の値は上へ戻る) */
function validNewlineArg(arg: string): boolean {
  return /^(half|-?\d+(\.\d+)?)$/.test(arg.trim());
}

export function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  const flush = () => {
    if (text) tokens.push({ type: 'text', text });
    text = '';
  };
  const s = script;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '%') {
      if (s.startsWith('%property[', i)) {
        const end = s.indexOf(']', i);
        if (end > 0) {
          flush();
          tokens.push({ type: 'env', name: 'property:' + s.slice(i + 10, end), raw: s.slice(i, end + 1) });
          i = end + 1;
          continue;
        }
      }
      const name = ENV_NAMES.find((n) => s.startsWith(n, i + 1));
      if (name) {
        flush();
        tokens.push({ type: 'env', name, raw: '%' + name });
        i += name.length + 1;
        continue;
      }
      text += c;
      i++;
      continue;
    }
    if (c !== '\\' || i + 1 >= s.length) {
      text += c;
      i++;
      continue;
    }
    const tagStart = i;
    i++;
    const next = s[i];
    if (next === '\\' || next === '%') {
      text += next;
      i++;
      continue;
    }
    let name = '';
    while (s[i] === '_') {
      name += '_';
      i++;
    }
    if (i >= s.length) {
      text += s.slice(tagStart);
      break;
    }
    name += s[i];
    i++;
    if (name === '_?' || name === '_!') {
      // 次の同じ印までは、タグを実行せずにそのまま表示する
      const close = s.indexOf('\\' + name, i);
      text += s.slice(i, close < 0 ? s.length : close).replace(/[\r\n]/g, '');
      i = close < 0 ? s.length : close + 1 + name.length;
      continue;
    }
    flush();
    let args: string[] = [];
    if (SHORT_DIGIT.has(name) && /\d/.test(s[i] ?? '')) {
      args = [s[i]];
      i++;
    } else if (name === 'q' && /[\d[]/.test(s[i] ?? '')) {
      // 旧形式 \q[ID][タイトル] / \q0[ID][タイトル] (数字は通し番号) → [タイトル, ID] に揃える。
      // 旧形式の選択肢は1つずつ改行される
      let j = i;
      while (/\d/.test(s[j] ?? '')) j++;
      const serial = j > i;
      if (s[j] === '[') {
        const a = parseBracket(s, j);
        if (s[a.end] === '[' && (serial || a.args.length === 1)) {
          const b = parseBracket(s, a.end);
          tokens.push({ type: 'tag', name: 'q', args: [b.args.join(','), a.args.join(',')], raw: s.slice(tagStart, b.end) });
          tokens.push({ type: 'tag', name: 'n', args: [], raw: '' });
          i = b.end;
          continue;
        }
        args = a.args;
        i = a.end;
      } else {
        i = j;
      }
    } else if (s[i] === '[' && BRACKET.has(name)) {
      const look = parseBracket(s, i);
      if (name !== 'n' || validNewlineArg(look.args.join(','))) {
        args = look.args;
        i = look.end;
      }
    }
    tokens.push({ type: 'tag', name, args, raw: s.slice(tagStart, i) });
  }
  flush();
  return tokens;
}
