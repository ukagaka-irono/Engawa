import type { EmscriptenFS } from '../shiori/native-engines';
import { mediaInfo } from './media-info';
import type { SaoriEffect } from './context';
import { buildSaoriResponse, parseSaoriRequest, type SaoriResult } from './protocol';

/**
 * SAORI over DirectSSTP (ukadoc の「SAORI over DirectSSTP」、SSP 2.9.13 から)。SHIORI が Direct SSTP でベースウェアに送る
 * SAORI/1.0 の要求に答え、ベースウェアの内蔵モジュール (internal_…) を DLL の無い SAORI として使わせる。
 * 華和梨 9 の callsaori "internal_file" … などがこれを使う (native/engines.mjs で、華和梨の Direct SSTP をここにつなぐ)。
 *
 * Engawa が持つもの: internal_file の MediaInfo (音声のタグと長さ)、internal_system の ListModules・ListFunctions。
 * --async=識別子 を付けると 204 をすぐ返し、結果はあとでゴーストへイベントで届ける。
 */

export interface InternalSaoriContext {
  /** SHIORI のメモリ上のファイルシステムと、ゴーストの ghost/master の場所 (相対パスの基準) */
  fs: EmscriptenFS;
  root: string;
  /** メインスレッドに頼むこと (--async の結果のイベント) */
  post(effect: SaoriEffect): void;
}

const FUNCTIONS: Record<string, string[]> = {
  internal_file: ['MediaInfo'],
  internal_system: ['ListModules', 'ListFunctions'],
};

/** SAORI/1.0 の要求なら応答を、そうでなければ (Direct SSTP の EXECUTE SSTP など) undefined を返す */
export function internalSaori(bytes: Uint8Array, ctx: InternalSaoriContext): Uint8Array | undefined {
  const first = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).split(/\r?\n/)[0] ?? '';
  if (!/\sSAORI\/1\.\d\s*$/i.test(first)) return undefined;
  const req = parseSaoriRequest(bytes);
  const answer = (res: SaoriResult) => buildSaoriResponse(res, req.charset);
  const moduleName = (req.headers.get('module') ?? '').trim();
  if (!moduleName) return answer({ status: 400, error: 'invalid parameter' });
  const module = Object.keys(FUNCTIONS).find((m) => m.toLowerCase() === moduleName.toLowerCase());
  if (!module) return answer({ status: 400, error: 'unknown module' });
  if (/^GET\s+Version$/i.test(req.method)) return answer({ status: 200, result: 'Engawa Internal' });
  if (!/^EXECUTE$/i.test(req.method)) return answer({ status: 400, error: 'invalid parameter' });
  const func = FUNCTIONS[module].find((f) => f.toLowerCase() === (req.args[0] ?? '').toLowerCase());
  if (!func) return answer({ status: 400, error: 'unknown function' });
  // 位置引数の後ろの --名前=値 がオプション (MediaInfo は、2番目以降の位置で最初に -- で始まるものから後ろ)
  const args = req.args.slice(1);
  const firstOption = args.findIndex((a, i) => i >= (func === 'MediaInfo' ? 1 : 0) && a.startsWith('--'));
  const positional = firstOption < 0 ? args : args.slice(0, firstOption);
  const options = new Map<string, string>();
  for (const o of firstOption < 0 ? [] : args.slice(firstOption)) {
    const m = /^--([\w-]+)=(.*)$/.exec(o);
    if (!m) return answer({ status: 400, error: 'invalid parameter' });
    options.set(m[1].toLowerCase(), m[2]);
  }
  const asyncId = options.get('async');
  options.delete('async');
  if (asyncId === '' || options.size) return answer({ status: 400, error: 'invalid parameter' });

  let run: () => SaoriResult;
  if (module === 'internal_system') {
    run = () =>
      func === 'ListModules'
        ? { status: 200, result: Object.keys(FUNCTIONS).join(','), values: Object.keys(FUNCTIONS) }
        : (() => {
            const target = Object.keys(FUNCTIONS).find((m) => m.toLowerCase() === (positional[0] ?? '').toLowerCase());
            return target ? { status: 200, result: FUNCTIONS[target].join(','), values: FUNCTIONS[target] } : { status: 400, error: 'unknown module' };
          })();
  } else {
    // MediaInfo: Argument1 = パス (相対は ghost/master から。区切りは / も \ も)、Argument2 以降 = 欲しい値のキー (1〜11個)
    const [path, ...keys] = positional;
    if (!path || !keys.length || keys.length > 11 || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return answer({ status: 400, error: 'invalid parameter' });
    const abs = resolvePath(path, ctx.root);
    const found = ctx.fs.analyzePath(abs).exists && ctx.fs.isFile(ctx.fs.stat(abs).mode);
    if (!found) return answer({ status: 400, error: 'file not found' });
    run = () => {
      const info = mediaInfo(ctx.fs.readFile(abs), keys);
      return { status: 200, result: info.result, values: info.values };
    };
  }
  if (asyncId === undefined) return answer(run());
  // 結果は、この要求に答えた後でゴーストへイベントで届ける (識別子が On… ならその名前、そうでなければ OnInternalSaori…)
  setTimeout(() => {
    let res: SaoriResult;
    try {
      res = run();
    } catch {
      res = { status: 500, error: 'internal error' };
    }
    const ok = res.status === 200 || res.status === 204;
    const event = /^On/.test(asyncId) ? (ok ? asyncId : `${asyncId}Failure`) : ok ? 'OnInternalSaoriComplete' : 'OnInternalSaoriFailure';
    const refs = ok ? [asyncId, res.result ?? '', module, func, ...(res.values ?? [])] : [asyncId, res.error ?? '', module, func];
    ctx.post({ kind: 'event', id: event, refs });
  }, 0);
  return answer({ status: 204 });
}

/** ゴーストの ghost/master からの相対パス (/ も \ も区切り)。/ で始まるものはそのまま */
function resolvePath(path: string, root: string): string {
  const p = path.replace(/\\/g, '/');
  return p.startsWith('/') ? p : `${root}/${p}`;
}
