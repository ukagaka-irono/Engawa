import type { Bitmap } from '../util/image';

/**
 * SERIKO の合成系の描画メソッド (blend-*)。ukadoc の「描画メソッド」。
 * canvas が持つ合成モードはそれで描き、無いものはピクセルごとに計算する。
 * -fast はベースレイヤの不透明な所にだけ合成する (外形を変えない)。
 */

const NATIVE: Record<string, GlobalCompositeOperation> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  'color-dodge': 'color-dodge',
  // 発光は覆い焼きの明るさを足すもの。canvas には無いので近い合成で代える
  'color-dodge-glow': 'color-dodge',
  'color-burn': 'color-burn',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  add: 'lighter',
  'add-glow': 'lighter',
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** チャンネルごとの合成 (b = ベース、s = 新規、0〜1) */
const CHANNEL: Record<string, (b: number, s: number) => number> = {
  'vivid-light': (b, s) => (s <= 0.5 ? (s === 0 ? 0 : clamp(1 - (1 - b) / (2 * s))) : s === 1 ? 1 : clamp(b / (2 * (1 - s)))),
  'linear-burn': (b, s) => clamp(b + s - 1),
  'linear-light': (b, s) => clamp(b + 2 * s - 1),
  'pin-light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard-mix': (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => clamp(b - s),
};

/** 画素ごとの合成 (darker-color / lighter-color は3色をまとめて比べる) */
function pixelBlend(mode: string, b: [number, number, number], s: [number, number, number]): [number, number, number] {
  if (mode === 'darker-color' || mode === 'lighter-color') {
    const lum = (c: [number, number, number]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const darker = lum(s) < lum(b);
    return (mode === 'darker-color') === darker ? s : b;
  }
  const f = CHANNEL[mode];
  return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
}

/** blend-xxx(-fast) / 旧称 (overlaymultiply・overlayscreen) を [合成, fast] にする。合成系でなければ undefined */
export function parseBlend(method: string): { mode: string; fast: boolean } | undefined {
  const m = method.toLowerCase();
  if (m === 'overlaymultiply') return { mode: 'multiply', fast: true };
  if (m === 'overlayscreen') return { mode: 'screen', fast: true };
  const r = /^blend-(.+?)(-fast)?$/.exec(m);
  if (!r) return undefined;
  const mode = r[1];
  if (!(mode in NATIVE) && !(mode in CHANNEL) && mode !== 'darker-color' && mode !== 'lighter-color') return undefined;
  return { mode, fast: !!r[2] };
}

function translation(ctx: CanvasRenderingContext2D): { e: number; f: number } {
  const t = (ctx as CanvasRenderingContext2D & { getTransform?: () => DOMMatrix }).getTransform?.();
  return t ? { e: t.e, f: t.f } : { e: 0, f: 0 };
}

/** ctx の今の絵に img を (x, y) へ合成する。alpha は新規レイヤの不透明度 (0〜1) */
export function drawBlend(ctx: CanvasRenderingContext2D, img: Bitmap, x: number, y: number, mode: string, fast: boolean, alpha = 1): void {
  const native = NATIVE[mode];
  if (native) {
    if (!fast) {
      ctx.save();
      ctx.globalCompositeOperation = native;
      ctx.globalAlpha *= alpha;
      ctx.drawImage(img, x, y);
      ctx.restore();
      return;
    }
    // ベースを写した上で合成し、それをベースの不透明な所にだけ戻す
    const { e, f } = translation(ctx);
    const tmp = document.createElement('canvas');
    tmp.width = ctx.canvas.width;
    tmp.height = ctx.canvas.height;
    const t = tmp.getContext('2d')!;
    t.drawImage(ctx.canvas, 0, 0);
    t.globalCompositeOperation = native;
    t.globalAlpha = alpha;
    t.drawImage(img, x + e, y + f);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    return;
  }
  // canvas に無い合成は、重なる範囲の画素を計算する
  const { e, f } = translation(ctx);
  const dx = Math.round(x + e);
  const dy = Math.round(y + f);
  const left = Math.max(0, dx);
  const top = Math.max(0, dy);
  const right = Math.min(ctx.canvas.width, dx + img.width);
  const bottom = Math.min(ctx.canvas.height, dy + img.height);
  if (right <= left || bottom <= top) return;
  const w = right - left;
  const h = bottom - top;
  const base = ctx.getImageData(left, top, w, h);
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  src.getContext('2d')!.drawImage(img, dx - left, dy - top);
  const s = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const d = base.data;
  for (let i = 0; i < d.length; i += 4) {
    const as = (s[i + 3] / 255) * alpha;
    if (as === 0) continue;
    const ad = d[i + 3] / 255;
    if (fast && ad === 0) continue;
    const cb: [number, number, number] = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    const cs: [number, number, number] = [s[i] / 255, s[i + 1] / 255, s[i + 2] / 255];
    const mixed = pixelBlend(mode, cb, cs);
    // W3C の合成 (混色の後に source-over)。fast はベースの外形のまま
    const ao = fast ? ad : as + ad * (1 - as);
    for (let c = 0; c < 3; c++) {
      const blended = (1 - ad) * cs[c] + ad * mixed[c];
      const out = fast ? as * mixed[c] + (1 - as) * cb[c] : (as * blended + (1 - as) * ad * cb[c]) / (ao || 1);
      d[i + c] = Math.round(clamp(out) * 255);
    }
    d[i + 3] = Math.round(ao * 255);
  }
  ctx.putImageData(base, left, top);
}
