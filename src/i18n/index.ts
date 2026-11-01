/**
 * 画面の文字の言語 (メニュー・ダイアログ・通知)。日本語の表 (ja.ts) を元に、言語ごとの表から引く。
 * 言語は設定 (settings.language) か、無ければブラウザの言語 (navigator.languages) から選ぶ。
 * 言語の名前と ID は SSP の言語パック (ukatech/ssp-i18n の descript.txt の name・id) に合わせ、
 * ゴーストには OnLanguageChange で知らせる。
 */
import { settings } from '../ghost/settings';
import { en } from './en';
import { ja, type MessageKey, type Messages } from './ja';
import { ko } from './ko';
import { zhHans } from './zh-hans';
import { zhHant } from './zh-hant';

export type { MessageKey, Messages };

export interface Language {
  /** BCP 47 の言語タグ (設定に保存し、画面の lang 属性にする) */
  code: string;
  /** その言語で書いた名前 (言語を選ぶ一覧に出す) */
  name: string;
  /** SSP の言語名 (OnLanguageChange の Reference0) */
  sspName: string;
  /** SSP の言語 ID (OnLanguageChange の Reference1)。SSP に組み込みの日本語は 0 */
  langId: number;
  /** SSP の言語パックのフォルダ名 (OnLanguageChange の Reference2 の仮のパス)。組み込みの日本語には無い */
  folder?: string;
  /** メニューのアクセスキーを、項目名の中の同じ文字に下線を引いて示す (英語の「&Help」)。無ければ「名前(H)」 */
  inlineAccessKeys?: boolean;
  messages: Messages;
}

export const LANGUAGES: readonly Language[] = [
  { code: 'ja', name: '日本語', sspName: 'Japanese', langId: 0, messages: ja },
  { code: 'en', name: 'English', sspName: 'English', langId: 1033, folder: 'english', inlineAccessKeys: true, messages: en },
  { code: 'zh-Hans', name: '简体中文', sspName: 'Chinese-Simplified', langId: 2052, folder: 'chinese-simplified', messages: zhHans },
  { code: 'zh-Hant', name: '繁體中文', sspName: 'Chinese-Traditional', langId: 1028, folder: 'chinese-traditional', messages: zhHant },
  { code: 'ko', name: '한국어', sspName: 'Korean', langId: 1042, folder: 'korean', messages: ko },
];

const byCode = (code: string | undefined) => LANGUAGES.find((l) => l.code.toLowerCase() === code?.toLowerCase());

/**
 * ブラウザの言語の並び (navigator.languages) から、表のある言語を選ぶ。
 * 中国語は繁体字の地域 (台湾・香港・マカオ) と zh-Hant を繁体字に、それ以外を簡体字にする。
 * どれにも当たらなければ英語 (並びが空なら日本語)
 */
export function detectLanguage(prefs: readonly string[]): Language {
  for (const pref of prefs) {
    const tag = pref.toLowerCase();
    const primary = tag.split('-')[0];
    if (primary === 'zh') return byCode(/-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-Hant' : 'zh-Hans')!;
    const hit = byCode(primary);
    if (hit) return hit;
  }
  return byCode(prefs.length ? 'en' : 'ja')!;
}

/** ブラウザの言語 (navigator が無ければ日本語) */
export function browserLanguage(): Language {
  if (typeof navigator !== 'object') return LANGUAGES[0];
  const prefs = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  return detectLanguage(prefs);
}

let current: Language | undefined;
const listeners = new Set<(lang: Language) => void>();

/** いまの言語。初めて使うときに設定 (無ければブラウザの言語) から選ぶ */
export function language(): Language {
  return (current ??= byCode(settings.language) ?? browserLanguage());
}

/** 言語を変える (undefined ならブラウザの言語)。変わったら onLanguageChange の関数を呼ぶ */
export function setLanguage(code: string | undefined): Language {
  const before = current;
  current = byCode(code) ?? browserLanguage();
  if (current !== before) for (const fn of listeners) fn(current);
  return current;
}

/** 言語が変わったら呼ぶ。止めるときは返した関数を呼ぶ */
export function onLanguageChange(fn: (lang: Language) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 表から文字を引き、{名前} を params の値で置き換える */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = language().messages[key] ?? ja[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}

/** data-i18n (文字)・data-i18n-aria-label (読み上げ名) を付けた要素を、いまの言語の文字にする */
export function translateElements(root: ParentNode): void {
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n]')) e.textContent = t(e.dataset.i18n as MessageKey);
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) e.setAttribute('aria-label', t(e.dataset.i18nAriaLabel as MessageKey));
}
