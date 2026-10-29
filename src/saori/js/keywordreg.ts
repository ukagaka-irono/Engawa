import { decodeText } from '../../util/text';
import type { SaoriContext } from '../context';
import { findFile, type JsSaori } from '../host';

/** カタカナをひらがなに、全角の英数字を半角にする (漢字の読みは分からない) */
function hiragana(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

interface Entry {
  result: string;
  keywords: string[];
}

/** keyword.txt (Shift_JIS)。「結果=キーワード,キーワード…」。＝ と 、､， も区切りに使え、# ＃ から後は注釈 */
function readKeywords(ctx: SaoriContext): Entry[] {
  const path = findFile(ctx.fs, `${ctx.dir}keyword.txt`);
  if (!path) return [];
  const entries: Entry[] = [];
  for (const raw of decodeText(ctx.fs.readFile(path), 'Shift_JIS').split(/\r?\n/)) {
    const line = raw.replace(/[#＃].*$/, '').trim();
    const eq = line.search(/[=＝]/);
    if (eq <= 0) continue;
    const keywords = line
      .slice(eq + 1)
      .split(/[,、､，]/)
      .map((k) => hiragana(k.trim()))
      .filter(Boolean);
    entries.push({ result: line.slice(0, eq).trim(), keywords });
  }
  return entries;
}

/**
 * KeywordReg.dll。文章に含まれるキーワードから、keyword.txt の結果を選ぶ。
 * Windows 版は IME で漢字をひらがなにしてから探すが、ブラウザには IME の変換が無いので、
 * カタカナ・全角英数字をそろえるだけにする (NOCONVERT を付けたときに近い)。GETYOMI・GETKANJI は候補なし
 */
export function keywordReg(ctx: SaoriContext): JsSaori {
  let entries: Entry[] = [];
  return {
    load() {
      entries = readKeywords(ctx);
    },
    execute({ args }) {
      const command = (args[0] ?? '').toUpperCase();
      const text = args[1] ?? '';
      if (command.includes('GETKEYWORD')) {
        const converted = hiragana(text);
        const hits = entries.filter((e) => e.keywords.some((k) => converted.includes(k))).map((e) => e.result);
        return { result: hits.join('　'), values: [converted] };
      }
      if (command.includes('GETYOMI') || command.includes('GETKANJI')) return { result: '0' };
      return { status: 400 };
    },
  };
}
