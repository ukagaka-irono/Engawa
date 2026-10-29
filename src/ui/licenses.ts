/**
 * メニューの「ライセンス」で見せる文。index.html に組み込んでいる SHIORI (native/build.mjs が書いたもの) と
 * ライブラリの著作権表示・条文。BSD・MIT などは、バイナリを配るときにも一緒に配る決まりなので、ここに全部入れる。
 */
import DIALOG_POLYFILL from '../../node_modules/dialog-polyfill/LICENSE?raw';
import FFLATE from '../../node_modules/fflate/LICENSE?raw';

const shiori = import.meta.glob<string>('../assets/shiori/*.LICENSES.txt', { query: '?raw', import: 'default', eager: true });

const rule = '='.repeat(72);

export function licenseText(): string {
  const engines = Object.entries(shiori)
    .filter(([path]) => !path.endsWith('/COMMON.LICENSES.txt'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.trim());
  const common = Object.entries(shiori).find(([path]) => path.endsWith('/COMMON.LICENSES.txt'))?.[1].trim();
  return [
    'Engawa に組み込んでいる SHIORI (WebAssembly にしたもの) とライブラリのライセンスです。',
    ...engines,
    `fflate (MIT)\n\n${FFLATE.trim()}`,
    `dialog-polyfill (BSD 3-Clause)\n\n${DIALOG_POLYFILL.trim()}`,
    ...(common ? [common] : []),
  ].join(`\n\n${rule}\n\n`);
}
