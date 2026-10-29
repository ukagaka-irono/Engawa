import { containsText } from '../util/bytes';

/**
 * ゴーストが同梱している SAORI の DLL が、Engawa で作り直したもののどれに当たるか。
 * メインスレッド (WebAssembly のものの本体を送るため) と Worker (開かれたときに作るため) の両方が使う。
 *
 * 中身では、DLL の書き出し表にある DLL じしんの名前で見分ける (UPX で縮めた DLL でも、この名前は読める)。
 */

/** JavaScript で作り直したもの (src/saori/js/) */
export type JsSaoriKind =
  | 'textcopy2'
  | 'clipcopy'
  | 'playwavsound'
  | 'ccpuid'
  | 'advanced_sysinfo'
  | 'window_info'
  | 'getdesktopinfo'
  | 'bignum'
  | 'totp'
  | 'keywordreg';

/** WebAssembly にしたもの (native/saoris.mjs) */
export const WASM_SAORI_KINDS = [
  'timebkn',
  'xaoric',
  'sqlori',
  'mahjongutil',
  'texasholdem',
  'nodoka',
  'budoux',
  'calcs',
  'gengou',
  'resizedpng',
  'resizedpngmini',
  'qrcode',
  'piechart',
  'ssu',
  'yaya',
] as const;
export type WasmSaoriKind = (typeof WASM_SAORI_KINDS)[number];

export type SaoriKind = JsSaoriKind | WasmSaoriKind;

interface Rule {
  kind: SaoriKind;
  /** DLL のファイル名 (小文字) */
  names: string[];
  /** DLL の中身に含まれる文字列 (名前を変えた DLL でも見分けられる) */
  signatures: string[];
}

const RULES: Rule[] = [
  // JavaScript で作り直したもの
  { kind: 'textcopy2', names: ['textcopy2.dll'], signatures: ['textcopy2.dll'] },
  { kind: 'clipcopy', names: ['clipcopy.dll'], signatures: ['clipcopy.dll'] },
  { kind: 'playwavsound', names: ['playwavsound.dll'], signatures: ['PlayWavSound.dll'] },
  // ccpuid は saori_cpuid.dll の代わりとして、その名前で同梱されることがある
  { kind: 'ccpuid', names: ['ccpuid.dll', 'saori_cpuid.dll'], signatures: ['ccpuid.dll'] },
  { kind: 'advanced_sysinfo', names: ['advanced_sysinfo.dll'], signatures: ['advanced_sysinfo.dll'] },
  { kind: 'window_info', names: ['window_info.dll'], signatures: ['window_info.dll'] },
  { kind: 'getdesktopinfo', names: ['getdesktopinfo.dll'], signatures: ['GetDesktopInfo.dll'] },
  { kind: 'bignum', names: ['bignum.dll'], signatures: ['bignum.dll'] },
  { kind: 'totp', names: ['totp_saori.dll'], signatures: ['totp_saori.dll'] },
  { kind: 'keywordreg', names: ['keywordreg.dll'], signatures: ['KeywordReg.dll'] },
  // WebAssembly にしたもの
  { kind: 'timebkn', names: ['timebkn.dll'], signatures: ['timebkn.dll'] },
  { kind: 'xaoric', names: ['xaoric.dll'], signatures: ['xaoric.dll'] },
  { kind: 'sqlori', names: ['sqlori.dll'], signatures: ['sqlori.dll'] },
  { kind: 'mahjongutil', names: ['mahjongutil.dll'], signatures: ['MahjongUtil.dll'] },
  { kind: 'texasholdem', names: ['texasholdemutil.dll'], signatures: ['TexasHoldemUtil.dll'] },
  { kind: 'nodoka', names: ['nodoka.dll'], signatures: ['nodoka.dll'] },
  { kind: 'budoux', names: ['budoux.dll'], signatures: ['budoux.dll'] },
  { kind: 'calcs', names: ['calcs.dll'], signatures: ['calcs.dll'] },
  { kind: 'gengou', names: ['japanesegengou.dll'], signatures: ['japanesegengou.dll'] },
  { kind: 'resizedpng', names: ['resizedpng.dll'], signatures: ['resizedpng.dll'] },
  { kind: 'resizedpngmini', names: ['resizedpngmini.dll'], signatures: ['resizedpngmini.dll'] },
  { kind: 'qrcode', names: ['saori_qrcode.dll'], signatures: ['saori_qrcode.dll'] },
  { kind: 'piechart', names: ['piechart.dll'], signatures: ['piechart.dll'] },
  { kind: 'ssu', names: ['ssu.dll'], signatures: ['ssu.dll'] },
  // SAORI として開かれた YAYA (yaya-as-saori。中身は YAYA の SHIORI そのもの)
  { kind: 'yaya', names: ['yaya.dll'], signatures: ['yaya.dll'] },
];

/** WebAssembly にしたものか (メインスレッドが本体を送る) */
export const isWasmSaori = (kind: SaoriKind): kind is WasmSaoriKind => (WASM_SAORI_KINDS as readonly SaoriKind[]).includes(kind);

/** 中身の文字列で見分け、分からなければファイル名で決める */
export function detectSaori(path: string, data: Uint8Array): SaoriKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return (RULES.find((r) => r.signatures.some((s) => containsText(data, s))) ?? RULES.find((r) => r.names.includes(name)))?.kind;
}
