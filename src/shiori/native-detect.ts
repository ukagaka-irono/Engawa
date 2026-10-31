import type { FileTree } from '../vfs/files';
import { containsText, containsWideText, dllFileVersion } from '../util/bytes';
import type { EngineId } from './native-engines';
// 本体の wasm (gzip)。ビルドでは data: URL として index.html に埋め込まれる
import AYA5_WASM from '../assets/shiori/aya5.wasm.gz?url';
import EMO_WASM from '../assets/shiori/emo.wasm.gz?url';
import KAGARI_WASM from '../assets/shiori/kagari.wasm.gz?url';
import KAWARI_WASM from '../assets/shiori/kawari.wasm.gz?url';
import KAWARI7_WASM from '../assets/shiori/kawari7.wasm.gz?url';
import MINATO_WASM from '../assets/shiori/minato.wasm.gz?url';
import MINATO02_WASM from '../assets/shiori/minato02.wasm.gz?url';
import NASHI_WASM from '../assets/shiori/nashi.wasm.gz?url';
import PASTA_WASM from '../assets/shiori/pasta.wasm.gz?url';
import QUICKSHIORI_WASM from '../assets/shiori/quickshiori.wasm.gz?url';
import SATORI_WASM from '../assets/shiori/satori.wasm.gz?url';
import SATORI1_WASM from '../assets/shiori/satori1.wasm.gz?url';
import YAYA_WASM from '../assets/shiori/yaya.wasm.gz?url';

export interface NativeEngine {
  id: EngineId;
  /** 表示名 (情報ダイアログなど) */
  label: string;
  wasmUrl: string;
  /** 2 なら SHIORI/2.x しか話さない (shiori2.ts で読み替える) */
  protocol?: 2;
}

interface Rule extends NativeEngine {
  /** ゴーストが同梱している Windows の DLL の中身に含まれる文字列 (名前を変えた DLL でも見分けられる) */
  signatures: string[];
  /** 同じく、UTF-16 (ワイド文字列) で含まれる文字列 */
  wideSignatures?: string[];
  /** descript.txt の shiori に書かれる DLL の名前 */
  dllNames: string[];
  /** DLL が同梱されておらず名前でも分からないとき、ghost/master にあればその SHIORI とみなすファイル */
  markers: string[];
  /** 同梱の DLL が古い版で、動きの違う古い版のビルドを使うべきならそれを返す (無ければ最新の版で動かす) */
  older?(dll: Uint8Array): NativeEngine | undefined;
}

/**
 * 里々 1.x (Mc1xx)。2.x (Mc2xx) は Unicode 版になり、全角文字の自動ウェイトや calc の比較などが変わった。
 * 1.x の DLL はファイルバージョンが 1.x で、文字列を ASCII で持つ (2.x は 2.x で、UTF-16 で持つ)
 */
const SATORI1: NativeEngine = { id: 'satori1', label: '里々 1.x', wasmUrl: SATORI1_WASM };
function olderSatori(dll: Uint8Array): NativeEngine | undefined {
  const version = dllFileVersion(dll);
  return (version ? version[0] < 2 : containsText(dll, 'satori_conf') || containsText(dll, 'phase Mc')) ? SATORI1 : undefined;
}

/**
 * minato 0.2.x 以前。0.3 から、呼んだ関数・トークから呼び出し元の let が見えなくなった。
 * DLL は版の文字列を作者名のすぐ後ろに持つ (…craftmanmizuki0.2.2not initialized…)
 */
const MINATO02: NativeEngine = { id: 'minato02', label: 'minato 0.2', wasmUrl: MINATO02_WASM };
function olderMinato(dll: Uint8Array): NativeEngine | undefined {
  const m = /craftmanmizuki(\d+)\.(\d+)\.\d+/.exec(new TextDecoder('latin1').decode(dll));
  return m && Number(m[1]) === 0 && Number(m[2]) < 3 ? MINATO02 : undefined;
}

const RULES: Rule[] = [
  { id: 'yaya', label: 'YAYA', wasmUrl: YAYA_WASM, signatures: ['yaya.dll'], dllNames: ['yaya.dll'], markers: ['yaya.txt'] },
  // YAYA を aya5.dll に名前を変えたものは中身に yaya.dll があるので、上の YAYA になる
  { id: 'aya5', label: '文', wasmUrl: AYA5_WASM, signatures: ['aya5.dll'], dllNames: ['aya5.dll'], markers: ['aya5.txt'] },
  // 里々 2.x の DLL は文字列を UTF-16 で持つので、そちらでも探す。1.x の DLL なら 1.x のビルドを使う
  {
    id: 'satori',
    label: '里々',
    wasmUrl: SATORI_WASM,
    signatures: ['satori_conf', 'phase Mc'],
    wideSignatures: ['satori_conf', 'phase Mc'],
    dllNames: ['satori.dll'],
    markers: ['satori_conf.txt'],
    older: olderSatori,
  },
  // 華和梨のゴーストは shiori.dll に名前を変えていることが多いので、中身の文字列と kawarirc.kis で見分ける
  { id: 'kawari', label: '華和梨', wasmUrl: KAWARI_WASM, signatures: ['kawarirc.kis'], dllNames: ['kawari.dll'], markers: ['kawarirc.kis'] },
  // 華和梨 7 は kawari.ini を読む (8 は kawarirc.kis なので、8 の後に調べる)。SHIORI/2.x だけを話す
  { id: 'kawari7', label: '華和梨 7', wasmUrl: KAWARI7_WASM, protocol: 2, signatures: ['kawari.ini'], dllNames: ['kawari7.dll'], markers: ['kawari.ini'] },
  // なし栞のファイル名はワイド文字列なので、DLL の中の ASCII の応答 (Sender: nashi) で見分ける
  { id: 'nashi', label: 'なし栞', wasmUrl: NASHI_WASM, signatures: ['Sender: nashi'], dllNames: ['nashi.dll'], markers: ['ghost.json'] },
  // minato は shiori.dll に名前を変えて同梱されるので、最初に読む台本の名前 (main.mnt) で見分ける
  { id: 'minato', label: 'minato', wasmUrl: MINATO_WASM, signatures: ['main.mnt'], dllNames: ['minato.dll'], markers: ['talks/main.mnt'], older: olderMinato },
  // pasta (Rust と Lua) は pasta.toml を読む。中に Lua の台本 (main.lua など) を持つので、kagari より先に調べる
  { id: 'pasta', label: 'pasta', wasmUrl: PASTA_WASM, signatures: ['pasta.toml'], dllNames: ['pasta.dll'], markers: ['pasta.toml'] },
  // emo (Rust と Lua 5.3。pasta の前身) は emo/shiori/init.lua を読む。DLL の中のログの文字で見分ける
  { id: 'emo', label: 'emo', wasmUrl: EMO_WASM, signatures: ['[emo::unload]'], dllNames: ['emo.dll'], markers: ['emo/shiori/init.lua'] },
  // kagari (Lua 5.4) は index.lua を読む。kotori のゴーストには kagari.conf.lua がある
  { id: 'kagari', label: 'kagari', wasmUrl: KAGARI_WASM, signatures: ['index.lua'], dllNames: ['kagari.dll'], markers: ['kagari.conf.lua'] },
  // quickshiori (QuickJS) は index.js の globalThis.__shiori_request を呼ぶ
  { id: 'quickshiori', label: 'quickshiori', wasmUrl: QUICKSHIORI_WASM, signatures: ['__shiori_request'], dllNames: ['quickshiori.dll'], markers: ['index.js'] },
];


/** WebAssembly にしていない SHIORI の DLL (灯・蒼空・.NET・PowerShell、SHIOLINK で別のプログラムを呼ぶもの) */
const OTHER_ENGINES = ['akari.dll', 'aosora.dll', 'dnproxy.dll', 'powershiori.dll', 'shiolink.dll'];

/**
 * ゴーストの SHIORI が WebAssembly 版のどれに当たるか。
 * 同梱の DLL があればその中身の文字列で (shiori.dll などに名前を変えてあっても分かる)、無ければ DLL の名前、
 * それでも分からなければ ghost/master にある SHIORI ごとの設定ファイルで決める。
 */
export function detectNativeEngine(dllName: string, files: FileTree): NativeEngine | undefined {
  const name = dllName.toLowerCase();
  // WebAssembly にできない SHIORI と分かっている DLL なら、設定ファイルで当て推量しない
  // (灯のプラグインが YAYA as SAORI の yaya.txt を持っているときに、YAYA として動かしてしまわないように)
  if (OTHER_ENGINES.includes(name.replace(/^.*[\\/]/, ''))) return undefined;
  const dll = files.get(`ghost/master/${dllName}`);
  const rule =
    (dll &&
      (RULES.find((r) => r.signatures.some((s) => containsText(dll, s))) ??
        RULES.find((r) => r.wideSignatures?.some((s) => containsWideText(dll, s))))) ||
    RULES.find((r) => r.dllNames.includes(name)) ||
    RULES.find((r) => r.markers.some((m) => files.has(`ghost/master/${m}`)));
  // 同梱の DLL が古い版なら、その版のビルドで動かす
  return (rule && dll && rule.older?.(dll)) || rule;
}
