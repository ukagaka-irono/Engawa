import { Descript } from '../package/descript';
import { loadTransparentImage, parseAlphaMode, type Bitmap } from '../util/image';
import type { FileTree } from '../vfs/files';

export type BalloonKind = 's' | 'k';

export interface TextRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 選択肢・アンカーのマーカーの見た目 (cursor.* / anchor.* と \f[cursor*] など)。style は square・underline を空白区切りで */
export interface MarkerLook {
  style: string;
  /** 矩形の中の色 (brush) */
  bg: string;
  /** 矩形の枠と下線の色 (pen) */
  pen: string;
  /** 文字の色 */
  font: string;
}

export interface MarkerLooks {
  /** 選択中の選択肢 (cursor.*) */
  cursor: MarkerLook;
  /** 選択していない選択肢 (cursor.notselect.*) */
  cursorNot: MarkerLook;
  /** 選択中のアンカー (anchor.*) */
  anchor: MarkerLook;
  /** 選択していないアンカー (anchor.notselect.*) */
  anchorNot: MarkerLook;
  /** 選んだことのあるアンカー (anchor.visited.*) */
  anchorVisited: MarkerLook;
}

export interface BalloonStyle {
  fontFamily: string;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
  fontUnderline: boolean;
  fontStrike: boolean;
  /** 白抜き (font.outline) */
  fontOutline: boolean;
  color: string;
  /** 陰落ちの色。無ければ undefined (既定は none) */
  shadowColor?: string;
  shadowStyle: 'offset' | 'outline';
  /** 無効な文字 (\f[disable]、disable.font.color) */
  disableColor: string;
  anchorColor: string;
  markers: MarkerLooks;
}

/** バルーンに重ねる小さな画像と、その位置 (arrow0.x など。負の値は右端・下端から) */
export interface BalloonPart {
  image: Bitmap;
  x: number;
  y: number;
}

const BUILTIN_SIZE: Record<BalloonKind, [number, number]> = { s: [280, 164], k: [224, 132] };

/** 負の値は右端・下端からの距離 */
function edge(value: number | undefined, size: number, fallback: number): number {
  const v = value ?? fallback;
  return v < 0 ? size + v : v;
}

/** 形状指定 (square / underline / square+underline / none) を、CSS の属性値 (空白区切り) にする */
export function markerStyle(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === 'default') return fallback;
  const parts = v.split('+').filter((p) => p === 'square' || p === 'underline');
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * バルーンの見た目。インストール済みバルーン (balloons0.png 等) か、画像を持たない内蔵バルーン。
 * 内蔵バルーンは CSS で描く (styles.css の .balloon-inner.builtin)。
 * 画像ごとの設定 (balloons1s.txt など) は descript.txt の同じ項目を上書きする。
 */
export class BalloonSkin {
  private constructor(
    readonly key: string | null,
    readonly name: string,
    readonly descript: Descript,
    private readonly images: Map<string, Bitmap>,
    private readonly perImage: Map<string, Descript>,
    /** バルーン画像以外の画像 (矢印・マーカーなど)。拡張子を除いた小文字のファイル名で引く */
    private readonly parts: Map<string, Bitmap>,
  ) {}

  static builtin(): BalloonSkin {
    return new BalloonSkin(null, '内蔵バルーン', new Descript(), new Map(), new Map(), new Map());
  }

  static async load(key: string, files: FileTree): Promise<BalloonSkin> {
    const descript = Descript.read(files, 'descript.txt');
    // use_self_alpha はバルーン全体の設定 (画像ごとの設定では変えない)
    const alpha = parseAlphaMode(descript.get('use_self_alpha'));
    const images = new Map<string, Bitmap>();
    const perImage = new Map<string, Descript>();
    const parts = new Map<string, Bitmap>();
    await Promise.all(
      files.list().map(async (path) => {
        const settings = /^balloon([sk])(\d+)s\.txt$/.exec(path);
        if (settings) {
          perImage.set(settings[1] + settings[2], Descript.read(files, path));
          return;
        }
        const m = /^balloon([sk])(\d+)\.png$/.exec(path);
        const part = /^([^/]+)\.png$/i.exec(path);
        if (!m && !part) return;
        const pna = files.get(path.replace(/\.png$/i, '.pna'));
        try {
          const img = await loadTransparentImage(files.get(path)!, pna, alpha);
          if (m) images.set(m[1] + m[2], img);
          else parts.set(part![1].toLowerCase(), img);
        } catch (e) {
          console.warn(`[balloon] ${path}:`, e);
        }
      }),
    );
    return new BalloonSkin(key, descript.str('name', key), descript, images, perImage, parts);
  }

  get isBuiltin(): boolean {
    return this.images.size === 0;
  }

  /** その種類のバルーン画像の数 */
  count(kind: BalloonKind): number {
    return Math.max(1, [...this.images.keys()].filter((k) => k[0] === kind).length);
  }

  /**
   * \b[n] の n と左右から画像を選ぶ。偶数が左置き、奇数が右置き (SSP と同じ)。
   * kero 用の画像が無いバルーンは sakura 用で代用する。
   */
  private imageKey(kind: BalloonKind, id: number, rightSide: boolean): string | undefined {
    const base = id - (id % 2);
    for (const k of [kind + (base + (rightSide ? 1 : 0)), kind + base, kind + (rightSide ? 1 : 0), kind + '0']) {
      if (this.images.has(k)) return k;
    }
    return kind === 'k' ? this.imageKey('s', id, rightSide) : undefined;
  }

  image(kind: BalloonKind, id: number, rightSide: boolean): Bitmap | undefined {
    const k = this.imageKey(kind, id, rightSide);
    return k ? this.images.get(k) : undefined;
  }

  size(kind: BalloonKind, id: number, rightSide: boolean): [number, number] {
    const img = this.image(kind, id, rightSide);
    return img ? [img.width, img.height] : BUILTIN_SIZE[kind];
  }

  /** その画像に効く設定値 (画像ごとの設定 → descript.txt) */
  value(kind: BalloonKind, id: number, rightSide: boolean, name: string): string | undefined {
    const k = this.imageKey(kind, id, rightSide);
    return (k ? this.perImage.get(k)?.get(name) : undefined) ?? this.descript.get(name);
  }

  private num(kind: BalloonKind, id: number, rightSide: boolean, name: string): number | undefined {
    const v = this.value(kind, id, rightSide, name);
    if (v === undefined) return undefined;
    const n = Number(v.split(',')[0]);
    return Number.isFinite(n) ? n : undefined;
  }

  /** prefix.r / .g / .b の色。どれかが none なら 'none'、無ければ fallback */
  private rgb(kind: BalloonKind, id: number, rightSide: boolean, prefix: string, fallback: string): string {
    const raw = ['r', 'g', 'b'].map((c) => this.value(kind, id, rightSide, `${prefix}.${c}`));
    if (raw.some((v) => v?.trim().toLowerCase() === 'none')) return 'none';
    const [r, g, b] = ['r', 'g', 'b'].map((c) => this.num(kind, id, rightSide, `${prefix}.${c}`));
    if (r === undefined || g === undefined || b === undefined) return fallback;
    return `rgb(${r}, ${g}, ${b})`;
  }

  textRect(kind: BalloonKind, id: number, rightSide: boolean, width: number, height: number): TextRect {
    if (this.isBuiltin) return { left: 16, top: 14, right: width - 16, bottom: height - 14 };
    const num = (name: string) => this.num(kind, id, rightSide, name);
    return {
      left: edge(num('origin.x') ?? num('validrect.left'), width, 10),
      top: edge(num('origin.y') ?? num('validrect.top'), height, 10),
      right: edge(num('wordwrappoint.x') ?? num('validrect.right'), width, -10),
      bottom: edge(num('validrect.bottom'), height, -10),
    };
  }

  /**
   * バルーンの部品の画像 (矢印・マーカーなど)。名前ごとの個別の画像 (markers / markerk) があればそれ。
   * nameKey は descript.txt で名前を変える項目 (marker.filename など)、fallback はその既定の名前。
   */
  partImage(kind: BalloonKind, nameKey: string, fallback: string, suffix = ''): Bitmap | undefined {
    const base = (this.descript.get(nameKey) ?? fallback).trim().toLowerCase().replace(/\.png$/, '');
    return this.parts.get(`${base}${kind}${suffix}`) ?? this.parts.get(`${base}${suffix}`);
  }

  /** 部品の位置 (prefix.x / prefix.y)。どちらかが無ければ undefined */
  partPoint(kind: BalloonKind, id: number, rightSide: boolean, prefix: string, width: number, height: number): { x: number; y: number } | undefined {
    const x = this.num(kind, id, rightSide, `${prefix}.x`);
    const y = this.num(kind, id, rightSide, `${prefix}.y`);
    if (x === undefined || y === undefined) return undefined;
    return { x: edge(x, width, 0), y: edge(y, height, 0) };
  }

  /** 部品の右端・下端の位置 (number.xr / sstpmessage.xr など、負の値は右端・下端から) */
  partEdge(kind: BalloonKind, id: number, rightSide: boolean, name: string, size: number): number | undefined {
    const v = this.num(kind, id, rightSide, name);
    return v === undefined ? undefined : edge(v, size, 0);
  }

  style(kind: BalloonKind, id: number, rightSide: boolean): BalloonStyle {
    const value = (name: string) => this.value(kind, id, rightSide, name);
    const flag = (name: string) => value(name)?.trim() === '1';
    const rgb = (prefix: string, fallback: string) => this.rgb(kind, id, rightSide, prefix, fallback);
    const font = value('font.name');
    const color = rgb('font.color', 'var(--balloon-text)');
    const shadow = rgb('font.shadowcolor', 'none');
    const look = (prefix: string, fallback: MarkerLook): MarkerLook => ({
      style: markerStyle(value(`${prefix}.style`), fallback.style),
      bg: rgb(`${prefix}.brush.color`, fallback.bg),
      pen: rgb(`${prefix}.pen.color`, fallback.pen),
      font: rgb(`${prefix}.font.color`, fallback.font),
    });
    const anchorColor = rgb('anchor.font.color', 'var(--balloon-anchor)');
    const cursor = look('cursor', { style: 'square', bg: 'var(--balloon-cursor-bg)', pen: 'var(--balloon-cursor-bg)', font: 'var(--balloon-cursor-text)' });
    const anchorNot = look('anchor.notselect', { style: 'underline', bg: 'transparent', pen: 'currentColor', font: anchorColor });
    return {
      fontFamily: font ? `${font.split(',').map((f) => `"${f.trim().replace(/"/g, '')}"`).join(', ')}, var(--font-balloon)` : 'var(--font-balloon)',
      fontSize: this.num(kind, id, rightSide, 'font.height') ?? 12,
      fontBold: flag('font.bold'),
      fontItalic: flag('font.italic'),
      fontUnderline: flag('font.underline'),
      fontStrike: flag('font.strike'),
      fontOutline: flag('font.outline'),
      color,
      shadowColor: shadow === 'none' ? undefined : shadow,
      shadowStyle: value('font.shadowstyle')?.trim().toLowerCase() === 'outline' ? 'outline' : 'offset',
      disableColor: rgb('disable.font.color', 'var(--balloon-disabled)'),
      anchorColor,
      markers: {
        cursor,
        cursorNot: look('cursor.notselect', { style: 'none', bg: 'transparent', pen: 'currentColor', font: 'inherit' }),
        anchor: look('anchor', { style: 'underline', bg: 'transparent', pen: 'currentColor', font: anchorColor }),
        anchorNot,
        anchorVisited: look('anchor.visited', anchorNot),
      },
    };
  }
}
