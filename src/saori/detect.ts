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
  | 'keywordreg'
  | 'curl'
  | 'chttpc'
  | 'saori_ip'
  | 'iptools'
  | 'uds'
  | 'nullsaori'
  | 'saoritest'
  | 'example'
  | 'call_translator'
  | 'fileversion'
  | 'makotoutil'
  | 'aqtalk'
  | 'setcursorpos'
  | 'osuwari'
  | 'screenshot'
  | 'set_wall_paper'
  | 'steam_api'
  | 'tsvnexec'
  | 'cmdrunner'
  | 'imoutomessenger'
  | 'gainer'
  | 'effect_wrapper'
  | 'proxy_ex'
  | 'mciaudio'
  | 'mciaudior'
  | 'httpc'
  | 'gomi'
  | 'findwin'
  | 'cpuusage'
  | 'choice'
  | 'os_detect'
  | 'process'
  | 'textcopy'
  | 'houchi'
  | 'hotkey'
  | 'screencatch'
  | 'handutil';

/** WebAssembly にしたもの (native/saoris.mjs) */
export const WASM_SAORI_KINDS = [
  'timebkn',
  'xaoric',
  'sqlori',
  'mahjongutil',
  'texasholdem',
  'nodoka',
  'mio',
  'budoux',
  'calcs',
  'gengou',
  'resizedpng',
  'resizedpngmini',
  'qrcode',
  'piechart',
  'ssu',
  'yaya',
  'satori',
  'kawari',
  'kisaragi',
  'sqlori2',
] as const;
export type WasmSaoriKind = (typeof WASM_SAORI_KINDS)[number];

export type SaoriKind = JsSaoriKind | WasmSaoriKind;

interface Rule {
  kind: SaoriKind;
  /** DLL のファイル名 (小文字) */
  names: string[];
  /** DLL の中身に含まれる文字列 (名前を変えた DLL でも見分けられる) */
  signatures: string[];
  /**
   * ゴーストに DLL が無くても使えるもの (ninix-saori。ninix ではベースウェアの側に置くので、ゴーストは同梱しない)。
   * そのファイル名で開かれたら、この SAORI を渡す
   */
  builtin?: boolean;
}

const RULES: Rule[] = [
  // JavaScript で作り直したもの
  { kind: 'textcopy2', names: ['textcopy2.dll'], signatures: ['textcopy2.dll'] },
  // SSP が内蔵している互換モジュール (ukadoc の spec/saori-ex)。SSP と同じく、ゴーストに DLL が無くても名前で使える
  { kind: 'clipcopy', names: ['clipcopy.dll'], signatures: ['clipcopy.dll'], builtin: true },
  { kind: 'textcopy', names: ['textcopy.dll'], signatures: ['textcopy.dll'], builtin: true },
  { kind: 'mciaudior', names: ['mciaudior.dll'], signatures: ['mciaudior.dll'] },
  { kind: 'mciaudio', names: ['mciaudio.dll'], signatures: ['mciaudio.dll'], builtin: true },
  { kind: 'houchi', names: ['houchi.dll'], signatures: ['houchi.dll'], builtin: true },
  { kind: 'cpuusage', names: ['cpuusage.dll'], signatures: ['cpuusage.dll'], builtin: true },
  { kind: 'playwavsound', names: ['playwavsound.dll'], signatures: ['PlayWavSound.dll'] },
  // ccpuid は saori_cpuid.dll の代わりとして、その名前で同梱されることがある
  { kind: 'ccpuid', names: ['ccpuid.dll', 'saori_cpuid.dll'], signatures: ['ccpuid.dll'], builtin: true },
  { kind: 'advanced_sysinfo', names: ['advanced_sysinfo.dll'], signatures: ['advanced_sysinfo.dll'] },
  { kind: 'window_info', names: ['window_info.dll'], signatures: ['window_info.dll'] },
  { kind: 'getdesktopinfo', names: ['getdesktopinfo.dll'], signatures: ['GetDesktopInfo.dll'] },
  { kind: 'bignum', names: ['bignum.dll'], signatures: ['bignum.dll'] },
  { kind: 'totp', names: ['totp_saori.dll'], signatures: ['totp_saori.dll'] },
  { kind: 'keywordreg', names: ['keywordreg.dll'], signatures: ['KeywordReg.dll'] },
  // chttpc の中には httpc.dll の綴りも入っているので、先に調べる
  { kind: 'chttpc', names: ['chttpc.dll'], signatures: ['chttpc.dll'] },
  { kind: 'httpc', names: ['httpc.dll'], signatures: ['httpc.dll'], builtin: true },
  { kind: 'saori_ip', names: ['ip.dll', 'saori_ip.dll'], signatures: ['GetInternetIP'], builtin: true },
  { kind: 'iptools', names: ['iptools.dll'], signatures: ['iptools.dll'] },
  { kind: 'uds', names: ['uds.dll'], signatures: ['UpDownSpeed'] },
  { kind: 'nullsaori', names: ['nullsaori.dll'], signatures: ['nullsaori.dll'] },
  { kind: 'saoritest', names: ['saoritest.dll'], signatures: ['SaoriTest.dll'] },
  { kind: 'fileversion', names: ['fileversion.dll'], signatures: ['FileVersion.dll'] },
  { kind: 'makotoutil', names: ['makotoutil.dll'], signatures: ['MakotoUtil.dll'] },
  { kind: 'aqtalk', names: ['aqtalksaori.dll'], signatures: ['AquesTalk.dll'] },
  { kind: 'choice', names: ['choice.dll'], signatures: [] },
  { kind: 'os_detect', names: ['os_detect.dll'], signatures: [] },
  // process.dll という名前の SAORI は2つある (りゅうのものとは別)。Tatakinov のものは中の文字で見分ける
  { kind: 'process', names: [], signatures: ['SAORI_ChildProcess'] },
  // Windows の機能そのものを使うもの (ブラウザでは行えないので、できなかったときの答えを返す)
  { kind: 'setcursorpos', names: ['setcursorpos.dll'], signatures: ['SetCursorPos.dll'] },
  { kind: 'osuwari', names: ['osuwari.dll'], signatures: ['Osuwari.dll'] },
  { kind: 'screenshot', names: ['screenshot.dll'], signatures: ['screenshot.dll'] },
  { kind: 'set_wall_paper', names: ['set_wall_paper.dll'], signatures: ['set_wall_paper.dll'] },
  { kind: 'tsvnexec', names: ['tsvnexec.dll'], signatures: ['tsvnexec.dll'] },
  { kind: 'cmdrunner', names: ['cmdrunner.dll'], signatures: ['cmdrunner.dll'] },
  { kind: 'imoutomessenger', names: ['imoutomessenger.dll'], signatures: ['imoutomessenger.dll'] },
  { kind: 'gainer', names: ['gainer.dll'], signatures: ['gainer.dll'] },
  { kind: 'effect_wrapper', names: ['effect_wrapper.dll'], signatures: ['effect_wrapper.dll'] },
  { kind: 'proxy_ex', names: ['proxy_ex.dll'], signatures: ['proxy_ex.dll'] },
  { kind: 'steam_api', names: ['steam_api.dll'], signatures: [] },
  { kind: 'gomi', names: ['gomi.dll'], signatures: [] },
  { kind: 'handutil', names: ['handutil.dll'], signatures: [] },
  { kind: 'findwin', names: ['findwin.dll'], signatures: [] },
  { kind: 'hotkey', names: ['hotkey.dll'], signatures: [] },
  { kind: 'screencatch', names: ['screencatch.dll'], signatures: [] },
  // ninix-saori (ninix-kagari のベースウェア側の SAORI)
  { kind: 'curl', names: ['saori_curl.dll'], signatures: ['saori-curl'], builtin: true },
  { kind: 'example', names: ['example.dll'], signatures: [], builtin: true },
  { kind: 'call_translator', names: ['saori_call_translator.dll'], signatures: [], builtin: true },
  // WebAssembly にしたもの
  { kind: 'timebkn', names: ['timebkn.dll'], signatures: ['timebkn.dll'] },
  { kind: 'xaoric', names: ['xaoric.dll'], signatures: ['xaoric.dll'] },
  // SQLite 2 で組んだ古い sqlori (データベースのファイルが SQLite 3 と違う)
  { kind: 'sqlori2', names: ['sqlori-sqlite2.dll', 'sqlori_sqlite2.dll'], signatures: ['SQLite 2.1 database'] },
  { kind: 'sqlori', names: ['sqlori.dll'], signatures: ['sqlori.dll'] },
  { kind: 'kisaragi', names: ['kisaragi.dll'], signatures: ['kisaragi.dll'] },
  // MahjongUtilCustom (Tatakinov) は、時間切れにならないようにした同じ使い方のもの
  { kind: 'mahjongutil', names: ['mahjongutil.dll', 'mahjongutilcustom.dll'], signatures: ['MahjongUtil.dll'] },
  { kind: 'texasholdem', names: ['texasholdemutil.dll'], signatures: ['TexasHoldemUtil.dll'] },
  { kind: 'nodoka', names: ['nodoka.dll'], signatures: ['nodoka.dll'] },
  { kind: 'mio', names: ['mio.dll'], signatures: [] },
  { kind: 'budoux', names: ['budoux.dll'], signatures: ['budoux.dll'] },
  { kind: 'calcs', names: ['calcs.dll'], signatures: ['calcs.dll'] },
  { kind: 'gengou', names: ['japanesegengou.dll'], signatures: ['japanesegengou.dll'] },
  { kind: 'resizedpng', names: ['resizedpng.dll'], signatures: ['resizedpng.dll'] },
  { kind: 'resizedpngmini', names: ['resizedpngmini.dll'], signatures: ['resizedpngmini.dll'] },
  { kind: 'qrcode', names: ['saori_qrcode.dll'], signatures: ['saori_qrcode.dll'] },
  { kind: 'piechart', names: ['piechart.dll'], signatures: ['piechart.dll'] },
  { kind: 'ssu', names: ['ssu.dll'], signatures: ['ssu.dll'] },
  // SAORI として開かれた YAYA (yaya-as-saori。中身は YAYA の SHIORI そのもの)
  { kind: 'yaya', names: ['yaya.dll', 'saori_yaya.dll'], signatures: ['yaya.dll'] },
  // ninix-saori の、里々・華和梨を SAORI として使うもの (要求をそのまま SHIORI に渡す)
  { kind: 'satori', names: ['saori_satori.dll'], signatures: [] },
  { kind: 'kawari', names: ['saori_kawari.dll'], signatures: [] },
];

/** WebAssembly にしたものか (メインスレッドが本体を送る) */
export const isWasmSaori = (kind: SaoriKind): kind is WasmSaoriKind => (WASM_SAORI_KINDS as readonly SaoriKind[]).includes(kind);

/** ゴーストに無くても使える SAORI (ninix-saori) のファイル名なら、その種類 */
export function builtinSaori(path: string): SaoriKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return RULES.find((r) => r.builtin && r.names.includes(name))?.kind;
}

/** 中身の文字列で見分け、分からなければファイル名で決める */
export function detectSaori(path: string, data: Uint8Array): SaoriKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return (RULES.find((r) => r.signatures.some((s) => containsText(data, s))) ?? RULES.find((r) => r.names.includes(name)))?.kind;
}
