import { Descript } from '../package/descript';
import { loadTransparentImage, parseAlphaMode, type AlphaMode, type Bitmap } from '../util/image';
import { FileTree, normalizePath } from '../vfs/files';
import { scaledSize } from '../sakura/player';
import { drawBlend, parseBlend } from './blend';
import { emptySurfaces, parseSurfaces, type CollisionDef, type DrawOptions, type SurfaceDef, type SurfacesFile } from './surfaces';

export interface BindGroup {
  id: number;
  category: string;
  part: string;
  default: boolean;
}

/** 合成済みのサーフェス (アニメーション抜きの静止画)。 */
export interface ComposedSurface {
  canvas: Bitmap;
  def?: SurfaceDef;
}

/**
 * 描画メソッドを canvas の合成モードに対応づけて描く。alpha は新規レイヤの不透明度 (--alpha)。
 * base / asis / insert の扱いは呼び出し側が決める (asis は透過処理していない画像を渡す)。
 */
export function drawWithMethod(ctx: CanvasRenderingContext2D, img: Bitmap, method: string, x: number, y: number, alpha = 1): void {
  const blend = parseBlend(method);
  if (blend) {
    drawBlend(ctx, img, x, y, blend.mode, blend.fast, alpha);
    return;
  }
  ctx.save();
  ctx.globalAlpha *= alpha;
  switch (method) {
    case 'interpolate':
      // ベースレイヤの透明な所にだけ重ねる
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(img, x, y);
      break;
    case 'overlayfast':
    case 'overlay-fast':
      // ベースレイヤの不透明度に応じて重ねる (ベースが透明な所には何も足さない)
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(img, x, y);
      break;
    case 'replace':
      ctx.clearRect(x, y, img.width, img.height);
      ctx.drawImage(img, x, y);
      break;
    case 'reduce':
      // 新規レイヤの透明度でベースを切り抜く。新規レイヤの範囲外は透明として扱う (ukadoc)
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(img, x, y);
      break;
    case 'insert':
      // 着せ替えの表示順の予約だけで、それ自体は何も描かない
      break;
    default: // overlay, base, bind, add, asis
      ctx.drawImage(img, x, y);
  }
  ctx.restore();
}

/** --clipping・--scaling を当てた画像 (どちらも無ければそのまま) */
export function applyDrawOptions(img: Bitmap, opts: DrawOptions): Bitmap {
  if (!opts.clip && !opts.scaling) return img;
  let src = img;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (opts.clip) {
    const [l, t, r, b] = opts.clip;
    sx = Math.max(0, Math.min(l, r));
    sy = Math.max(0, Math.min(t, b));
    sw = Math.max(1, Math.min(img.width, Math.max(l, r)) - sx);
    sh = Math.max(1, Math.min(img.height, Math.max(t, b)) - sy);
  }
  const size = scaledSize(sw, sh, opts.scaling) ?? { width: sw, height: sh, flipX: false, flipY: false };
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext('2d')!;
  ctx.translate(size.flipX ? size.width : 0, size.flipY ? size.height : 0);
  ctx.scale(size.flipX ? -1 : 1, size.flipY ? -1 : 1);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, size.width, size.height);
  src = out;
  return src;
}

/** SSP のシステムカーソル名を CSS のカーソルにする */
const SYSTEM_CURSORS: Record<string, string> = {
  arrow: 'default',
  cross: 'crosshair',
  no: 'not-allowed',
  hand: 'grab',
  grip: 'grabbing',
  finger: 'pointer',
  wait: 'wait',
  text: 'text',
  move: 'move',
  help: 'help',
};

/** シェル1つ分 (shell/<dir>/)。画像の読み込みと静止サーフェスの合成を受け持つ。 */
export class Shell {
  readonly descript: Descript;
  readonly surfaces: SurfacesFile;
  readonly name: string;
  private readonly alpha: AlphaMode;
  private readonly images = new Map<string, Promise<Bitmap | null>>();
  private readonly composed = new Map<number, Promise<ComposedSurface | null>>();
  private readonly ready = new Map<number, ComposedSurface | null>();
  private readonly rawReady = new Map<number, Bitmap | null>();
  private readonly regionImages = new Map<string, CanvasRenderingContext2D | null>();

  constructor(
    readonly dir: string,
    readonly files: FileTree,
  ) {
    this.descript = Descript.read(files, 'descript.txt');
    this.name = this.descript.str('name', dir);
    this.alpha = parseAlphaMode(this.descript.get('seriko.use_self_alpha'));
    this.surfaces = emptySurfaces();
    // surfaces.txt に加えて surfaces*.txt も読む (SSP 互換)。文字コードは各ファイルの charset 行で決まる
    const extra = files
      .list()
      .filter((p) => /^surfaces.+\.txt$/.test(p))
      .sort();
    const exists = (id: number) => this.surfaceFile(id) !== undefined;
    for (const path of ['surfaces.txt', ...extra]) {
      const text = files.text(path);
      if (text !== undefined) parseSurfaces(text, this.surfaces, exists);
    }
  }

  static fromGhost(ghostFiles: FileTree, dir: string): Shell {
    return new Shell(dir, ghostFiles.sub(`shell/${dir}`));
  }

  /** scope の接頭辞 (sakura / kero / char2…)。descript のキーやエイリアスに使う。 */
  static scopePrefix(scope: number): string {
    return scope === 0 ? 'sakura' : scope === 1 ? 'kero' : `char${scope}`;
  }

  surfaceFile(id: number): string | undefined {
    for (const name of [`surface${id}.png`, `surface${String(id).padStart(4, '0')}.png`]) {
      if (this.files.has(name)) return name;
    }
    return undefined;
  }

  /** 描けるサーフェスがあるか (画像か element がある。当たり判定だけの定義は数えない) */
  hasSurface(id: number): boolean {
    return this.surfaceFile(id) !== undefined || (this.surfaces.surfaces.get(id)?.elements.length ?? 0) > 0;
  }

  /** \s[...] の引数 (数字かエイリアス名) を実際のサーフェス ID にする。解決できなければ undefined。 */
  resolve(scope: number, arg: string): number | undefined {
    const key = arg.trim();
    const candidates = this.surfaces.aliases.get(Shell.scopePrefix(scope))?.get(key);
    if (candidates?.length) return candidates[Math.floor(Math.random() * candidates.length)];
    const n = Number(key);
    return key !== '' && Number.isFinite(n) ? n : undefined;
  }

  /** そのサーフェスのアニメーション ID (数字か animation*.name)。無ければ undefined */
  animationId(surfaceId: number, arg: string): number | undefined {
    const key = arg.trim();
    if (/^-?\d+$/.test(key)) return Number(key);
    for (const a of this.surfaces.surfaces.get(surfaceId)?.animations.values() ?? []) if (a.name === key) return a.id;
    // 今のサーフェスに無ければ、どこかの同じ名前のもの (同じ ID は同じ意味という決まり)
    for (const s of this.surfaces.surfaces.values()) for (const a of s.animations.values()) if (a.name === key) return a.id;
    return undefined;
  }

  /** パターンに名前で書かれたサーフェスの番号 */
  surfaceByName(name: string): number | undefined {
    for (const s of this.surfaces.surfaces.values()) for (const a of s.animations.values()) if (a.name === name) return s.id;
    return this.resolve(0, name);
  }

  /**
   * 当たり判定の上のマウスカーソル (CSS の値)。state は mouseup・mousedown・mousehover など。
   * cursor ブレスが無ければ、当たり判定の上は指差し (bust は手)
   */
  cursor(scope: number, collision: string, state: string, fileUrl: (path: string) => string | undefined): string | undefined {
    const rules = this.surfaces.cursors.get(Shell.scopePrefix(scope));
    const rule = rules?.find((r) => r.state === state && r.collision === collision) ?? (state === 'mousehover' ? undefined : rules?.find((r) => r.state === 'mouseup' && r.collision === collision));
    if (rule) {
      const sys = /^system:(\w+)$/i.exec(rule.file);
      if (sys) return SYSTEM_CURSORS[sys[1].toLowerCase()] ?? 'default';
      const url = fileUrl(rule.file);
      return url ? `url(${url}), pointer` : 'pointer';
    }
    if (!collision) return undefined;
    if (state === 'mousedown') return collision.toLowerCase() === 'bust' ? 'grabbing' : 'pointer';
    return collision.toLowerCase() === 'bust' ? 'grab' : 'pointer';
  }

  /** 当たり判定のツールチップ (tooltips ブレス) */
  tooltip(scope: number, collision: string): string | undefined {
    return collision ? this.surfaces.tooltips.get(Shell.scopePrefix(scope))?.get(collision) : undefined;
  }

  /** collisionex の region (画像の指定色の部分) に当たるか。画像を読み終えるまでは当たらない */
  regionAt(c: CollisionDef, x: number, y: number): boolean {
    const r = c.region;
    if (!r) return false;
    const img = this.regionImages.get(r.file);
    if (img === undefined) {
      this.regionImages.set(r.file, null);
      void this.image(r.file, true).then((bmp) => {
        if (!bmp) return;
        const ctx = bmp.getContext('2d', { willReadFrequently: true });
        if (ctx) this.regionImages.set(r.file, ctx);
      });
      return false;
    }
    if (!img || x < 0 || y < 0 || x >= img.canvas.width || y >= img.canvas.height) return r.invert;
    const d = img.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    const same = d[0] === r.color[0] && d[1] === r.color[1] && d[2] === r.color[2];
    return same !== r.invert;
  }

  bindGroups(scope: number): BindGroup[] {
    const prefix = Shell.scopePrefix(scope);
    const out: BindGroup[] = [];
    for (const key of this.descript.keys()) {
      const m = new RegExp(`^${prefix}\\.bindgroup(\\d+)\\.name$`).exec(key);
      if (!m) continue;
      const id = Number(m[1]);
      const [category = '', part = ''] = this.descript.str(key).split(',');
      out.push({ id, category, part, default: this.descript.num(`${prefix}.bindgroup${id}.default`) === 1 });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** 画像を読む。raw は透過処理をしない (asis 用)。 */
  image(file: string, raw = false): Promise<Bitmap | null> {
    const path = normalizePath(file);
    const cacheKey = (raw ? 'raw:' : '') + path;
    let p = this.images.get(cacheKey);
    if (!p) {
      const data = this.files.get(path) ?? this.files.get(path + '.png');
      const pna = raw ? undefined : this.files.get(path.replace(/\.[^./]+$/, '') + '.pna');
      p = data
        ? loadTransparentImage(data, pna, raw ? 'none' : this.alpha).catch((e) => {
            console.warn(`[shell] ${file}:`, e);
            return null;
          })
        : Promise.resolve(null);
      this.images.set(cacheKey, p);
    }
    return p;
  }

  /** 読み込みを試して、読めなかった (画像が壊れているなど) と分かっているサーフェス */
  failed(id: number): boolean {
    return this.ready.has(id) && this.ready.get(id) === null;
  }

  /** 合成済みのサーフェスを同期的に取る。まだなら undefined (読み込みを開始する)。 */
  peek(id: number): ComposedSurface | null | undefined {
    if (!this.ready.has(id)) void this.compose(id);
    return this.ready.get(id);
  }

  /** asis で重ねる、透過処理をしていないサーフェス画像。element だけのサーフェスは合成画像で代用する */
  peekRaw(id: number): Bitmap | null | undefined {
    if (!this.rawReady.has(id)) {
      const file = this.surfaceFile(id);
      if (!file) {
        const composed = this.peek(id);
        return composed === undefined ? undefined : (composed?.canvas ?? null);
      }
      void this.image(file, true).then((img) => this.rawReady.set(id, img));
    }
    return this.rawReady.get(id);
  }

  /** 読み込み待ち (peek / peekRaw が undefined だったもの) */
  load(id: number, raw = false): Promise<unknown> {
    const file = raw ? this.surfaceFile(id) : undefined;
    return file ? this.image(file, true).then((img) => this.rawReady.set(id, img)) : this.compose(id);
  }

  /**
   * element を重ねた静止サーフェスを作る。
   * element0 が無ければ surfaceN.png がベースになり、その上に element1 以降を重ねる (ukadoc)。
   */
  compose(id: number): Promise<ComposedSurface | null> {
    let p = this.composed.get(id);
    if (!p) {
      p = this.doCompose(id).then((r) => {
        this.ready.set(id, r);
        return r;
      });
      this.composed.set(id, p);
    }
    return p;
  }

  private async doCompose(id: number): Promise<ComposedSurface | null> {
    const def = this.surfaces.surfaces.get(id);
    const file = this.surfaceFile(id);
    const elements = def?.elements ?? [];
    if (elements.length === 0) {
      const img = file ? await this.image(file) : null;
      return img ? { canvas: img, def } : null;
    }
    const layers: { img: Bitmap | null; method: string; x: number; y: number; alpha: number }[] = [];
    if (file && !elements.some((e) => e.id === 0)) {
      layers.push({ img: await this.image(file), method: 'base', x: 0, y: 0, alpha: 1 });
    }
    const imgs = await Promise.all(elements.map((e) => this.image(e.file, e.method === 'asis')));
    elements.forEach((e, i) => {
      const img = imgs[i];
      layers.push({ img: img && applyDrawOptions(img, e), method: e.method, x: e.x, y: e.y, alpha: e.alpha ?? 1 });
    });

    let w = 0;
    let h = 0;
    for (const l of layers) {
      if (!l.img) continue;
      w = Math.max(w, l.x + l.img.width);
      h = Math.max(h, l.y + l.img.height);
    }
    if (w === 0 || h === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    let first = true;
    for (const l of layers) {
      if (!l.img) continue;
      // 最初のレイヤーはメソッドによらずそのまま置く (ベースが空のまま reduce などをしないように)
      if (first) {
        ctx.globalAlpha = l.alpha;
        ctx.drawImage(l.img, l.x, l.y);
        ctx.globalAlpha = 1;
      } else drawWithMethod(ctx, l.img, l.method, l.x, l.y, l.alpha);
      first = false;
    }
    return { canvas, def };
  }
}
