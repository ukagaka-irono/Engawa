import BUDOUX_WASM from '../assets/saori/budoux.wasm.gz?url';
import CALCS_WASM from '../assets/saori/calcs.wasm.gz?url';
import GENGOU_WASM from '../assets/saori/gengou.wasm.gz?url';
import KISARAGI_WASM from '../assets/saori/kisaragi.wasm.gz?url';
import MAHJONGUTIL_WASM from '../assets/saori/mahjongutil.wasm.gz?url';
import NODOKA_WASM from '../assets/saori/nodoka.wasm.gz?url';
import PIECHART_WASM from '../assets/saori/piechart.wasm.gz?url';
import QRCODE_WASM from '../assets/saori/qrcode.wasm.gz?url';
import RESIZEDPNG_WASM from '../assets/saori/resizedpng.wasm.gz?url';
import RESIZEDPNGMINI_WASM from '../assets/saori/resizedpngmini.wasm.gz?url';
import SQLORI_WASM from '../assets/saori/sqlori.wasm.gz?url';
import SQLORI2_WASM from '../assets/saori/sqlori2.wasm.gz?url';
import SSU_WASM from '../assets/saori/ssu.wasm.gz?url';
import TEXASHOLDEM_WASM from '../assets/saori/texasholdem.wasm.gz?url';
import TIMEBKN_WASM from '../assets/saori/timebkn.wasm.gz?url';
import XAORIC_WASM from '../assets/saori/xaoric.wasm.gz?url';
import KAWARI_WASM from '../assets/shiori/kawari.wasm.gz?url';
import SATORI_WASM from '../assets/shiori/satori.wasm.gz?url';
import YAYA_WASM from '../assets/shiori/yaya.wasm.gz?url';
import type { FileTree } from '../vfs/files';
import { detectSaori, isWasmSaori, type WasmSaoriKind } from './detect';
import type { WasmSaoriPlan } from './wasm';

/** WebAssembly にした SAORI の本体 (gzip)。ビルドでは data: URL として index.html に埋め込まれる */
const WASM_URLS: Record<WasmSaoriKind, string> = {
  timebkn: TIMEBKN_WASM,
  xaoric: XAORIC_WASM,
  sqlori: SQLORI_WASM,
  mahjongutil: MAHJONGUTIL_WASM,
  texasholdem: TEXASHOLDEM_WASM,
  nodoka: NODOKA_WASM,
  budoux: BUDOUX_WASM,
  calcs: CALCS_WASM,
  gengou: GENGOU_WASM,
  resizedpng: RESIZEDPNG_WASM,
  resizedpngmini: RESIZEDPNGMINI_WASM,
  qrcode: QRCODE_WASM,
  piechart: PIECHART_WASM,
  ssu: SSU_WASM,
  yaya: YAYA_WASM,
  satori: SATORI_WASM,
  kawari: KAWARI_WASM,
  kisaragi: KISARAGI_WASM,
  sqlori2: SQLORI2_WASM,
};

/**
 * ゴーストの ghost/master にある DLL のうち、WebAssembly にした SAORI に当たるものを探し、本体を読む (メインスレッド)。
 * SHIORI の DLL (shioriDll) と、SHIORI が自分で持っているもの (skip。里々の ssu) は除く。
 */
export async function planWasmSaori(files: FileTree, shioriDll: string, skip: WasmSaoriKind[] = []): Promise<WasmSaoriPlan[]> {
  const plans: WasmSaoriPlan[] = [];
  const wasm = new Map<WasmSaoriKind, Uint8Array>();
  for (const [path, data] of files.sub('ghost/master').entries()) {
    if (!/\.dll$/i.test(path) || path.toLowerCase() === shioriDll.toLowerCase()) continue;
    const kind = detectSaori(path, data);
    if (!kind || !isWasmSaori(kind) || skip.includes(kind)) continue;
    if (!wasm.has(kind)) wasm.set(kind, new Uint8Array(await (await fetch(WASM_URLS[kind])).arrayBuffer()));
    plans.push({ path, kind, wasm: wasm.get(kind)! });
  }
  return plans;
}
