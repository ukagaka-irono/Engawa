import type { SaoriContext } from '../context';
import type { JsSaori } from '../host';

/**
 * window_info.dll (CSaori)。ブラウザからはほかのアプリの窓は見えないので、Engawa のページだけを1つの窓として答える。
 *   (引数なし)     Result = 窓の数、Value = 題名
 *   info <hwnd>    Value0… = 題名・クラス名・窓の矩形・中の矩形・作業領域・スタイル・拡張スタイル・親・状態
 */
export function windowInfo(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const env = ctx.env();
      if ((args[0] ?? '').toLowerCase() !== 'info') return { result: '1', values: [env.title] };
      const left = env.windowLeft;
      const top = env.windowTop;
      return {
        result: env.title,
        values: [
          env.title,
          'Engawa',
          `${left},${top},${left + env.windowWidth},${top + env.windowHeight}`,
          `0,0,${env.windowWidth},${env.windowHeight}`,
          `0,0,${env.availWidth},${env.availHeight}`,
          'WS_VISIBLE',
          '',
          '0',
          'normal',
        ],
      };
    },
  };
}

/**
 * GetDesktopInfo.dll (CSaori)。デスクトップのアイコンやごみ箱は、ブラウザからは見えない。
 * アイコンは無し、ごみ箱は空として答える。
 */
export function getDesktopInfo(): JsSaori {
  return {
    execute({ args }) {
      const command = (args[0] ?? '').toLowerCase();
      if (command === 'get') return { status: 200, result: '' };
      if (command === 'query_trash') return { result: '0', values: ['0', '0'] };
      if (command === 'hwnd' || command === 'empty_trash') return { status: 204 };
      return { status: 400 };
    },
  };
}
