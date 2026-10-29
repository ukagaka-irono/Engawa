import type { SaoriContext } from '../context';
import { findFile, normalizePath, type JsSaori } from '../host';

/**
 * PlayWavSound.dll (CSaori)。Argument0 の WAV を鳴らし、Result に 1 を返す。
 * パスは DLL のあるディレクトリからの相対 (または絶対)。「system:名前」の Windows の音は鳴らさない。
 * 音はメインスレッドで鳴らす (自動再生の決まりで鳴らないこともあるが、結果は待たない)。
 */
export function playWavSound(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const target = args[0] ?? '';
      if (!target || /^hwnd$/i.test(target)) return { status: 204 };
      if (/^system:/i.test(target)) return { result: '1' };
      const asked = normalizePath(target, ctx.dir);
      const found = findFile(ctx.fs, asked);
      ctx.post({ kind: 'sound', path: (found ?? asked).slice(1), data: found ? ctx.fs.readFile(found) : undefined });
      return { result: '1' };
    },
  };
}
