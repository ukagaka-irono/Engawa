import type { SaoriContext } from '../context';
import type { JsSaori } from '../host';

/**
 * textcopy2.dll (CSaori)。Argument0 をクリップボードへ写す。
 * Argument1 が 0 でなければ Result に Argument0 を返し、Argument2 があればその文字列を改行にしてから写す。
 * Worker からはクリップボードに触れないので、メインスレッドに頼む (結果は待たない)。
 */
export function textcopy2(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const text = args[0] ?? '';
      if (!text) return { status: 400 };
      ctx.post({ kind: 'clipboard', text: args[2] ? text.split(args[2]).join('\r\n') : text });
      return Number(args[1]) ? { result: text } : { status: 204 };
    },
  };
}

/** clipcopy.dll (CSaori)。すべての Argument を改行でつなぎ、「\n」の2文字も改行にして写す */
export function clipcopy(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      if (args.length === 0) return { status: 400 };
      ctx.post({ kind: 'clipboard', text: args.join('\r\n').split('\\n').join('\r\n') });
      return { status: 200 };
    },
  };
}
