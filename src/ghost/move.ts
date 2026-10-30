/**
 * \![move] / \![moveasync] の引数 (ukadoc の「\![move]、\![moveasync]について」)。
 * 新しい書き方: --X=…,--Y=…,--time=…,--base=…,--base-offset=…,--move-offset=…,--option=…
 * 古い書き方:   X,Y,時間,基準,基準の位置,動かす位置
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MoveRequest {
  /** 省略か fix ならその座標は動かさない */
  x?: number;
  y?: number;
  time: number;
  /** screen・primaryscreen・global・me・スコープ番号・「本体側名/番号」 */
  base: string;
  baseOffset: string;
  moveOffset: string;
  ignoreSticky: boolean;
}

function coord(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === '' || t === 'fix') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function parseMove(args: string[]): MoveRequest {
  const req: MoveRequest = { time: 0, base: 'screen', baseOffset: 'left.top', moveOffset: 'left.top', ignoreSticky: false };
  const named = args.some((a) => a.trim().startsWith('--'));
  if (named) {
    for (const raw of args) {
      const m = /^--([\w-]+)=(.*)$/.exec(raw.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'x') req.x = coord(value);
      else if (key === 'y') req.y = coord(value);
      else if (key === 'time') req.time = Math.max(0, Number(value) || 0);
      else if (key === 'base') req.base = value || 'screen';
      else if (key === 'base-offset') req.baseOffset = value || 'left.top';
      else if (key === 'move-offset') req.moveOffset = value || 'left.top';
      else if (key === 'option' && value.toLowerCase() === 'ignore-sticky-window') req.ignoreSticky = true;
    }
    return req;
  }
  req.x = coord(args[0]);
  req.y = coord(args[1]);
  req.time = Math.max(0, Number(args[2]) || 0);
  if (args[3]?.trim()) req.base = args[3].trim();
  if (args[4]?.trim()) req.baseOffset = args[4].trim();
  if (args[5]?.trim()) req.moveOffset = args[5].trim();
  return req;
}

/** left.top などの位置を、矩形の中の点にする。base は point.basepos (無ければ中央下) */
export function anchorPoint(r: Rect, spec: string, basepos?: { x: number; y: number }): { x: number; y: number } {
  const [h = 'left', v = 'top'] = spec.toLowerCase().split('.');
  const x = h === 'right' ? r.left + r.width : h === 'center' ? r.left + r.width / 2 : h === 'base' ? r.left + (basepos?.x ?? r.width / 2) : r.left;
  const y = v === 'bottom' ? r.top + r.height : v === 'center' ? r.top + r.height / 2 : v === 'base' ? r.top + (basepos?.y ?? r.height) : r.top;
  return { x, y };
}

/**
 * 動かすキャラクターの左上の、行き先の座標。base は基準にする矩形 (screen ならデスクトップ全体)。
 * 省略した座標は今のまま
 */
export function moveTarget(req: MoveRequest, me: Rect, base: Rect, meBasepos?: { x: number; y: number }, baseBasepos?: { x: number; y: number }): { left: number; top: number } {
  const origin = anchorPoint(base, req.baseOffset, baseBasepos);
  const handle = anchorPoint({ left: 0, top: 0, width: me.width, height: me.height }, req.moveOffset, meBasepos);
  return {
    left: req.x === undefined ? me.left : origin.x + req.x - handle.x,
    top: req.y === undefined ? me.top : origin.y + req.y - handle.y,
  };
}
