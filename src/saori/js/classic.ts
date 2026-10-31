import type { SaoriContext } from '../context';
import type { JsSaori } from '../host';

/**
 * 古くから使われてきた SAORI のうち、ソースが公開されていないものを、使い方の説明 (umeici の SAORI COLLECTION など) から作り直したもの。
 * ブラウザでは行えないもの (ごみ箱・ほかのアプリの窓・CPU の負荷) は、元の SAORI が「何も無い」ときの答えを返す
 */

/**
 * gomi.dll (ふるごむ)。ごみ箱。-n で中の数 (Value0 は大きさ)、-e・-f で空にする (-a を付けると OnRecycleBinEmptied)。
 * ブラウザにごみ箱は無いので、いつも空と答える (空にするのは、もう空なのでできたことにする)
 */
export function gomi(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const flags = args.filter((a) => a.startsWith('-')).join('').replace(/-/g, '');
      if (flags.includes('n')) return { result: '0', values: ['0'] };
      if (flags.includes('e') || flags.includes('f')) {
        if (flags.includes('a')) ctx.post({ kind: 'event', id: 'OnRecycleBinEmptied', refs: [] });
        return { result: '1' };
      }
      if (flags.includes('V')) return { result: 'gomi (Engawa)' };
      return { status: 204 };
    },
  };
}

/** findwin.dll (りゅう)。ほかのアプリの窓を探す。ブラウザからは見えないので、見つからなかったと答える */
export function findwin(): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'find' || cmd === 'count' || cmd === 'getpid') return { result: '0' };
      if (cmd === 'getclass' || cmd === 'getcaption') return { result: '' };
      return { status: 400 };
    },
  };
}

/**
 * HandUtil.dll (浮子屋)。窓のハンドル (HWND) で、ほかのゴーストの窓の位置を読んだり動かしたりする。
 * ブラウザの Engawa には本当の窓のハンドルが無いので、元の SAORI が無効なハンドルを渡されたときと同じく答える
 * (GetRect は -9999、ほかは何もしない)
 */
export function handUtil(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'getrect') return { result: '-9999' };
      if (cmd === 'getfmo' || cmd === 'sakuraapi' || cmd === 'dsstpsend') return { result: '' };
      if (cmd === 'movewindow' || cmd === 'dakko' || cmd === 'timer') {
        ctx.log(`HandUtil: ブラウザでは窓を操作できません (${args.join(', ')})`);
        return { result: '0' };
      }
      return { status: 400 };
    },
  };
}

/** cpuusage.dll (りゅう)。get で CPU の使用率。ブラウザからは分からないので 0 */
export function cpuusage(): JsSaori {
  return {
    execute({ args }) {
      return (args[0] ?? 'get').toLowerCase() === 'get' ? { result: '0' } : { status: 400 };
    },
  };
}

/** choice.dll (ふるごむ)。引数の1つを選んで返す */
export function choice(): JsSaori {
  return {
    execute({ args }) {
      return args.length ? { result: args[Math.floor(Math.random() * args.length)] } : { status: 204 };
    },
  };
}

/**
 * os_detect.dll (Tatakinov)。getOSName で OS の名前 (Wine の上なら Linux など)。
 * Engawa はブラウザの中だが、ゴーストから見れば Windows のベースウェアとして振る舞うので Windows と答える
 */
export function osDetect(): JsSaori {
  return {
    execute({ args }) {
      return (args[0] ?? '').toLowerCase() === 'getosname' ? { result: 'Windows' } : { status: 400 };
    },
  };
}

/**
 * process.dll (Tatakinov。将棋・チェスのエンジンなどを子プロセスとして動かす)。
 * ブラウザではプログラムを起動できないので、spawn は失敗 (-1) と答える
 */
export function childProcess(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const cmd = (args[0] ?? '').toLowerCase();
      if (cmd === 'spawn') {
        ctx.log(`process: ブラウザではプログラムを起動できません (${args.slice(1).join(', ')})`);
        return { result: '-1' };
      }
      return { status: 204 };
    },
  };
}

/** textcopy.dll (橋本孔明)。Argument0 をクリップボードに写す。Argument1 が 0 でなければ、それを Result にも返す */
export function textcopy(ctx: SaoriContext): JsSaori {
  return {
    execute({ args }) {
      const text = args[0] ?? '';
      ctx.post({ kind: 'clipboard', text });
      return args[1] !== undefined && args[1] !== '0' ? { result: text } : { status: 204 };
    },
  };
}

/**
 * houchi.dll (りゅう)。読み込まれている間、利用者が操作していなければ、1分ごとに OnHouchi (R0 = 操作していない分数) を送る。
 * 時間はメインスレッド (Ghost) が数える
 */
export function houchi(ctx: SaoriContext): JsSaori {
  return {
    load() {
      ctx.post({ kind: 'houchi', on: true });
    },
    execute() {
      return { status: 204 };
    },
    unload() {
      ctx.post({ kind: 'houchi', on: false });
    },
  };
}
