/**
 * メニューの「ライセンス」で見せる文。index.html に組み込んでいる SHIORI・SAORI (native/build.mjs が書いたもの) と
 * ライブラリの著作権表示・条文。BSD・MIT などは、バイナリを配るときにも一緒に配る決まりなので、ここに全部入れる。
 */
import DECIMAL from '../../node_modules/decimal.js/LICENCE.md?raw';
import DIALOG_POLYFILL from '../../node_modules/dialog-polyfill/LICENSE?raw';
import FFLATE from '../../node_modules/fflate/LICENSE?raw';
import { t } from '../i18n';

const shiori = import.meta.glob<string>('../assets/shiori/*.LICENSES.txt', { query: '?raw', import: 'default', eager: true });
const saori = import.meta.glob<string>('../assets/saori/*.LICENSES.txt', { query: '?raw', import: 'default', eager: true });

const rule = '='.repeat(72);

/** 名前の順に並べる (すべてに共通のもの COMMON は最後に別に置く) */
const listed = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([path]) => !path.endsWith('/COMMON.LICENSES.txt'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.trim());

export function licenseText(): string {
  const common = Object.entries(shiori).find(([path]) => path.endsWith('/COMMON.LICENSES.txt'))?.[1].trim();
  return [
    t('licenses.intro'),
    ...listed(shiori),
    ...listed(saori),
    `fflate (MIT)\n\n${FFLATE.trim()}`,
    `decimal.js (${t('licenses.decimal')})\n\n${DECIMAL.trim()}`,
    `dialog-polyfill (BSD 3-Clause)\n\n${DIALOG_POLYFILL.trim()}`,
    ...(common ? [common] : []),
  ].join(`\n\n${rule}\n\n`);
}
