import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentEvents } from '../src/ghost/environment';
import { detectLanguage, language, LANGUAGES, onLanguageChange, setLanguage, t } from '../src/i18n';
import { ja } from '../src/i18n/ja';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('言語の表', () => {
  afterEach(() => void setLanguage('ja'));

  it('どの言語も日本語の表と同じキーと {名前} を持つ', () => {
    for (const lang of LANGUAGES) {
      expect(Object.keys(lang.messages).sort(), lang.code).toEqual(Object.keys(ja).sort());
      for (const [key, text] of Object.entries(ja)) {
        const translated = lang.messages[key as keyof typeof ja];
        expect(translated, `${lang.code} ${key}`).not.toBe('');
        expect(placeholders(translated), `${lang.code} ${key}`).toEqual(placeholders(text));
      }
    }
  });

  it('メニューの「…」(アクセスキーを入れる目印) はどの言語でも同じ字にする', () => {
    for (const lang of LANGUAGES) {
      for (const [key, text] of Object.entries(ja)) {
        if (!key.startsWith('menu.')) continue;
        expect(lang.messages[key as keyof typeof ja].endsWith('…'), `${lang.code} ${key}`).toBe(text.endsWith('…'));
      }
    }
  });

  it('{名前} を置き換え、言語を変えると表が変わる', () => {
    expect(t('menu.close', { name: 'さくら' })).toBe('「さくら」を閉じる');
    setLanguage('en');
    expect(t('menu.close', { name: 'Sakura' })).toBe('Close “Sakura”');
    // 値の中の {…} はそのまま
    expect(t('toast.notFound', { name: '{name}' })).toBe('“{name}” was not found');
    setLanguage('ko');
    expect(t('common.close')).toBe('닫기');
  });

  it('ブラウザの言語の並びから選ぶ (中国語は繁体字の地域を分ける。無ければ英語)', () => {
    const code = (prefs: string[]) => detectLanguage(prefs).code;
    expect(code(['ja-JP', 'en-US'])).toBe('ja');
    expect(code(['en-GB'])).toBe('en');
    expect(code(['fr-FR', 'ko-KR'])).toBe('ko');
    expect(code(['zh-CN'])).toBe('zh-Hans');
    expect(code(['zh'])).toBe('zh-Hans');
    expect(code(['zh-TW'])).toBe('zh-Hant');
    expect(code(['zh-HK'])).toBe('zh-Hant');
    expect(code(['zh-Hant-CN'])).toBe('zh-Hant');
    expect(code(['fr-FR', 'de-DE'])).toBe('en');
    expect(code([])).toBe('ja');
  });

  it('変わったときだけ知らせる。知らない言語はブラウザの言語に戻る', () => {
    const seen = vi.fn();
    const off = onLanguageChange(seen);
    setLanguage('ja');
    expect(seen).not.toHaveBeenCalled();
    setLanguage('zh-Hant');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].code).toBe('zh-Hant');
    off();
    setLanguage('xx');
    expect(language().code).toBe(detectLanguage(typeof navigator === 'object' ? [...(navigator.languages ?? [navigator.language])] : []).code);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('OnLanguageChange は SSP の言語パックの言語名・言語 ID で送る (日本語は組み込みの 0)', () => {
    const env = new EnvironmentEvents(
      () => [],
      () => undefined,
      {} as HTMLElement,
    );
    expect(env.languageRefs()).toEqual(['Japanese', '0', '', '']);
    setLanguage('en');
    expect(env.languageRefs()).toEqual(['English', '1033', '/language/english/', '']);
    setLanguage('zh-Hans');
    expect(env.languageRefs()).toEqual(['Chinese-Simplified', '2052', '/language/chinese-simplified/', '']);
    setLanguage('zh-Hant');
    expect(env.languageRefs()[1]).toBe('1028');
    setLanguage('ko');
    expect(env.languageRefs().slice(0, 2)).toEqual(['Korean', '1042']);
  });
});
