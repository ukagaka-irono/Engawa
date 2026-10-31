import { dllFileVersion } from '../../util/bytes';
import type { SaoriContext } from '../context';
import { findFile, normalizePath, type JsSaori } from '../host';

/**
 * mciaudio.dll (MIY) と mciaudior.dll (umeici)。1つの曲を読み込んで鳴らす。
 *   load,ファイル (DLL のあるディレクトリからの相対) / play (鳴っていれば一時停止、止まっていれば続きから) / loop / stop
 * 音はメインスレッドで鳴らす (Ghost の saoriAudio)。
 * mciaudior は construction 7 から、鳴り終わると OnMAAPlayFinish・繰り返すたびに OnMAAPlayLoop をゴーストに送る
 * (それより前の版と mciaudio は送らない。DLL のファイルバージョンの4つ目が construction)。
 * 結果は、できたら 1、ファイルが無いなど、できなかったら 0 (原作の答えの値は確かめられていない)
 */
export function mciAudio(ctx: SaoriContext, r: boolean): JsSaori {
  let events = false;
  if (r) {
    try {
      const v = dllFileVersion(ctx.fs.readFile(ctx.path));
      events = !v || v[3] >= 7;
    } catch {
      // DLL が読めなければ (SSP の内蔵の名前で呼ばれたなど) 新しい版として扱う
      events = true;
    }
  }
  const channel = ctx.path;
  let loaded = false;
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      switch (cmd) {
        case 'load': {
          const asked = normalizePath(args[1] ?? '', ctx.dir);
          const found = args[1] ? findFile(ctx.fs, asked) : undefined;
          if (!found) {
            loaded = false;
            return { result: '0' };
          }
          loaded = true;
          ctx.post({ kind: 'audio', channel, op: 'load', path: found.slice(1), data: ctx.fs.readFile(found), events });
          return { result: '1' };
        }
        case 'play':
        case 'loop':
        case 'stop':
          if (!loaded) return { result: '0' };
          ctx.post({ kind: 'audio', channel, op: cmd });
          return { result: '1' };
      }
      return { status: 400 };
    },
    unload() {
      if (loaded) ctx.post({ kind: 'audio', channel, op: 'close' });
    },
  };
}
