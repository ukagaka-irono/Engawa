import { gunzipSync } from 'fflate';
import createBudoux from '../assets/saori/budoux.mjs';
import createCalcs from '../assets/saori/calcs.mjs';
import createGengou from '../assets/saori/gengou.mjs';
import createMahjongutil from '../assets/saori/mahjongutil.mjs';
import createNodoka from '../assets/saori/nodoka.mjs';
import createPiechart from '../assets/saori/piechart.mjs';
import createQrcode from '../assets/saori/qrcode.mjs';
import createResizedpng from '../assets/saori/resizedpng.mjs';
import createResizedpngmini from '../assets/saori/resizedpngmini.mjs';
import createSqlori from '../assets/saori/sqlori.mjs';
import createSsu from '../assets/saori/ssu.mjs';
import createTexasholdem from '../assets/saori/texasholdem.mjs';
import createTimebkn from '../assets/saori/timebkn.mjs';
import createXaoric from '../assets/saori/xaoric.mjs';
import createYaya from '../assets/shiori/yaya.mjs';
import { callLoad, callRequest, mkdirs, walk } from '../shiori/native-call';
import type { EmscriptenFS, EngineFactory } from '../shiori/native-engines';
import { encodeCharset } from '../util/charset-encode';
import type { SaoriEffect } from './context';
import type { WasmSaoriKind } from './detect';
import type { SaoriModule } from './host';

/**
 * WebAssembly にした SAORI (native/saoris.mjs でビルド) を Worker の中で動かす。
 * SHIORI の load は同期で SAORI を開くので、SHIORI を読み込む前に作っておく。
 * それぞれの SAORI は自分のファイルシステムを持つので、ゴーストのファイルを同じパスに置き、
 * SAORI が書いたファイル (作った画像・データベース) は、要求のたびに SHIORI のファイルシステムとメインスレッドへ写す。
 */

interface WasmSaori {
  create: EngineFactory;
  /** load に渡すディレクトリの文字コード (CSaori の load は Windows と同じく CP932 で読む) */
  pathCharset: 'shift_jis' | 'utf-8';
  /** ファイルを書くもの。要求のたびに書いたファイルを探す */
  writes?: boolean;
}

export const WASM_SAORI: Record<WasmSaoriKind, WasmSaori> = {
  timebkn: { create: createTimebkn, pathCharset: 'shift_jis' },
  xaoric: { create: createXaoric, pathCharset: 'shift_jis' },
  sqlori: { create: createSqlori, pathCharset: 'shift_jis', writes: true },
  mahjongutil: { create: createMahjongutil, pathCharset: 'shift_jis' },
  texasholdem: { create: createTexasholdem, pathCharset: 'utf-8' },
  nodoka: { create: createNodoka, pathCharset: 'utf-8' },
  budoux: { create: createBudoux, pathCharset: 'utf-8' },
  calcs: { create: createCalcs, pathCharset: 'utf-8' },
  gengou: { create: createGengou, pathCharset: 'utf-8' },
  resizedpng: { create: createResizedpng, pathCharset: 'utf-8', writes: true },
  resizedpngmini: { create: createResizedpngmini, pathCharset: 'utf-8', writes: true },
  qrcode: { create: createQrcode, pathCharset: 'utf-8', writes: true },
  piechart: { create: createPiechart, pathCharset: 'utf-8', writes: true },
  ssu: { create: createSsu, pathCharset: 'utf-8' },
  // SAORI として使う YAYA。SHIORI の YAYA と同じもので、DLL のディレクトリの yaya.txt を読み、変数を書く
  yaya: { create: createYaya, pathCharset: 'utf-8', writes: true },
};

/** メインスレッドが送ってくる、ゴーストにある WebAssembly の SAORI */
export interface WasmSaoriPlan {
  /** ghost/master からの相対パス */
  path: string;
  kind: WasmSaoriKind;
  /** 本体 (gzip) */
  wasm: Uint8Array;
}

interface Services {
  /** SHIORI のファイルシステム (SAORI が書いたファイルを写す先) */
  fs: EmscriptenFS;
  root: string;
  post(effect: SaoriEffect): void;
  log(message: string): void;
}

/** SAORI を作る。files はゴーストのファイル (root からの相対パス)。返す表は DLL の絶対パスごと */
export async function prepareWasmSaori(plans: WasmSaoriPlan[], files: [string, Uint8Array][], services: Services): Promise<Map<string, SaoriModule>> {
  const made = new Map<string, SaoriModule>();
  for (const plan of plans) {
    const spec = WASM_SAORI[plan.kind];
    if (!spec) continue;
    const path = `${services.root}/${plan.path}`;
    try {
      const m = await spec.create({
        wasmBinary: gunzipSync(plan.wasm),
        locateFile: (p) => p,
        print: (s) => services.log(`[${plan.path}] ${s}`),
        printErr: (s) => services.log(`[${plan.path}] ${s}`),
      });
      // ゴーストのファイルを同じパスに置く。中身の配列は写さずに使う (SAORI が書き換えるときは、新しい配列になる)
      mkdirs(m.FS, services.root);
      for (const [rel, data] of files) {
        const slash = rel.lastIndexOf('/');
        if (slash >= 0) mkdirs(m.FS, `${services.root}/${rel.slice(0, slash)}`);
        m.FS.writeFile(`${services.root}/${rel}`, data, { canOwn: true });
      }
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      m.FS.chdir(dir);
      /** SAORI が since より後に書いたファイルを、SHIORI のファイルシステムとメインスレッドへ写す */
      const sync = (since: number) => {
        for (const [rel, abs] of walk(m.FS, services.root)) {
          if (new Date(m.FS.stat(abs).mtime).getTime() < since) continue;
          const data = m.FS.readFile(abs);
          const slash = rel.lastIndexOf('/');
          if (slash >= 0) mkdirs(services.fs, `${services.root}/${rel.slice(0, slash)}`);
          services.fs.writeFile(abs, data);
          services.post({ kind: 'write', path: `ghost/master/${rel}`, data: data.slice() });
        }
      };
      made.set(path, {
        load: () => callLoad(m, encodeCharset(dir, spec.pathCharset)),
        request(req) {
          const since = Date.now();
          const res = callRequest(m, req);
          if (spec.writes) sync(since);
          return res;
        },
        unload: () => !!m._unload(),
      });
    } catch (e) {
      services.log(`SAORI ${plan.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return made;
}
