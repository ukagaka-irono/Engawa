import type { FileTree } from '../vfs/files';
import type { EngineId } from './native-engines';
// 本体の wasm (gzip)。ビルドでは data: URL として index.html に埋め込まれる
import AYA5_WASM from '../assets/shiori/aya5.wasm.gz?url';
import KAGARI_WASM from '../assets/shiori/kagari.wasm.gz?url';
import KAWARI_WASM from '../assets/shiori/kawari.wasm.gz?url';
import KAWARI7_WASM from '../assets/shiori/kawari7.wasm.gz?url';
import MINATO_WASM from '../assets/shiori/minato.wasm.gz?url';
import NASHI_WASM from '../assets/shiori/nashi.wasm.gz?url';
import QUICKSHIORI_WASM from '../assets/shiori/quickshiori.wasm.gz?url';
import SATORI_WASM from '../assets/shiori/satori.wasm.gz?url';
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
  /** descript.txt の shiori に書かれる DLL の名前 */
  dllNames: string[];
  /** DLL が同梱されておらず名前でも分からないとき、ghost/master にあればその SHIORI とみなすファイル */
  markers: string[];
}

const RULES: Rule[] = [
  { id: 'yaya', label: 'YAYA', wasmUrl: YAYA_WASM, signatures: ['yaya.dll'], dllNames: ['yaya.dll'], markers: ['yaya.txt'] },
  // YAYA を aya5.dll に名前を変えたものは中身に yaya.dll があるので、上の YAYA になる
  { id: 'aya5', label: '文', wasmUrl: AYA5_WASM, signatures: ['aya5.dll'], dllNames: ['aya5.dll'], markers: ['aya5.txt'] },
  { id: 'satori', label: '里々', wasmUrl: SATORI_WASM, signatures: ['satori_conf'], dllNames: ['satori.dll'], markers: ['satori_conf.txt'] },
  // 華和梨のゴーストは shiori.dll に名前を変えていることが多いので、中身の文字列と kawarirc.kis で見分ける
  { id: 'kawari', label: '華和梨', wasmUrl: KAWARI_WASM, signatures: ['kawarirc.kis'], dllNames: ['kawari.dll'], markers: ['kawarirc.kis'] },
  // 華和梨 7 は kawari.ini を読む (8 は kawarirc.kis なので、8 の後に調べる)。SHIORI/2.x だけを話す
  { id: 'kawari7', label: '華和梨 7', wasmUrl: KAWARI7_WASM, protocol: 2, signatures: ['kawari.ini'], dllNames: ['kawari7.dll'], markers: ['kawari.ini'] },
  // なし栞のファイル名はワイド文字列なので、DLL の中の ASCII の応答 (Sender: nashi) で見分ける
  { id: 'nashi', label: 'なし栞', wasmUrl: NASHI_WASM, signatures: ['Sender: nashi'], dllNames: ['nashi.dll'], markers: ['ghost.json'] },
  // minato は shiori.dll に名前を変えて同梱されるので、最初に読む台本の名前 (main.mnt) で見分ける
  { id: 'minato', label: 'minato', wasmUrl: MINATO_WASM, signatures: ['main.mnt'], dllNames: ['minato.dll'], markers: ['talks/main.mnt'] },
  // kagari (Lua 5.4) は index.lua を読む。kotori のゴーストには kagari.conf.lua がある
  { id: 'kagari', label: 'kagari', wasmUrl: KAGARI_WASM, signatures: ['index.lua'], dllNames: ['kagari.dll'], markers: ['kagari.conf.lua'] },
  // quickshiori (QuickJS) は index.js の globalThis.__shiori_request を呼ぶ
  { id: 'quickshiori', label: 'quickshiori', wasmUrl: QUICKSHIORI_WASM, signatures: ['__shiori_request'], dllNames: ['quickshiori.dll'], markers: ['index.js'] },
];

function contains(data: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  const first = needle[0];
  outer: for (let i = data.indexOf(first); i >= 0 && i <= data.length - needle.length; i = data.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * ゴーストの SHIORI が WebAssembly 版のどれに当たるか。
 * 同梱の DLL があればその中身の文字列で (shiori.dll などに名前を変えてあっても分かる)、無ければ DLL の名前、
 * それでも分からなければ ghost/master にある SHIORI ごとの設定ファイルで決める。
 */
export function detectNativeEngine(dllName: string, files: FileTree): NativeEngine | undefined {
  const name = dllName.toLowerCase();
  const dll = files.get(`ghost/master/${dllName}`);
  if (dll) {
    const hit = RULES.find((r) => r.signatures.some((s) => contains(dll, s)));
    if (hit) return hit;
  }
  return RULES.find((r) => r.dllNames.includes(name)) ?? RULES.find((r) => r.markers.some((m) => files.has(`ghost/master/${m}`)));
}
