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

export interface BalloonStyle {
  fontFamily: string;
  fontSize: number;
  fontBold: boolean;
  color: string;
  anchorColor: string;
  cursorBackground: string;
  cursorColor: string;
  cursorStyle: 'square' | 'underline' | 'none';
}

const BUILTIN_SIZE: Record<BalloonKind, [number, number]> = { s: [280, 164], k: [224, 132] };

/** 負の値は右端・下端からの距離 */
function edge(value: number | undefined, size: number, fallback: number): number {
  const v = value ?? fallback;
  return v < 0 ? size + v : v;
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
  ) {}

  static builtin(): BalloonSkin {
    return new BalloonSkin(null, '内蔵バルーン', new Descript(), new Map(), new Map());
  }

  static async load(key: string, files: FileTree): Promise<BalloonSkin> {
    const descript = Descript.read(files, 'descript.txt');
    // use_self_alpha はバルーン全体の設定 (画像ごとの設定では変えない)
    const alpha = parseAlphaMode(descript.get('use_self_alpha'));
    const images = new Map<string, Bitmap>();
    const perImage = new Map<string, Descript>();
    await Promise.all(
      files.list().map(async (path) => {
        const settings = /^balloon([sk])(\d+)s\.txt$/.exec(path);
        if (settings) {
          perImage.set(settings[1] + settings[2], Descript.read(files, path));
          return;
        }
        const m = /^balloon([sk])(\d+)\.png$/.exec(path);
        if (!m) return;
        const pna = files.get(path.replace(/\.png$/, '.pna'));
        try {
          images.set(m[1] + m[2], await loadTransparentImage(files.get(path)!, pna, alpha));
        } catch (e) {
          console.warn(`[balloon] ${path}:`, e);
        }
      }),
    );
    return new BalloonSkin(key, descript.str('name', key), descript, images, perImage);
  }

  get isBuiltin(): boolean {
    return this.images.size === 0;
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
  private value(kind: BalloonKind, id: number, rightSide: boolean, name: string): string | undefined {
    const k = this.imageKey(kind, id, rightSide);
    return (k ? this.perImage.get(k)?.get(name) : undefined) ?? this.descript.get(name);
  }

  private num(kind: BalloonKind, id: number, rightSide: boolean, name: string): number | undefined {
    const v = this.value(kind, id, rightSide, name);
    if (v === undefined) return undefined;
    const n = Number(v.split(',')[0]);
    return Number.isFinite(n) ? n : undefined;
  }

  private rgb(kind: BalloonKind, id: number, rightSide: boolean, prefix: string, fallback: string): string {
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

  style(kind: BalloonKind, id: number, rightSide: boolean): BalloonStyle {
    const value = (name: string) => this.value(kind, id, rightSide, name);
    const font = value('font.name');
    const cursor = value('cursor.style') ?? '';
    return {
      fontFamily: font ? `"${font.replace(/"/g, '')}", var(--font-balloon)` : 'var(--font-balloon)',
      fontSize: this.num(kind, id, rightSide, 'font.height') ?? 12,
      fontBold: value('font.bold') === '1',
      color: this.rgb(kind, id, rightSide, 'font.color', 'var(--balloon-text)'),
      anchorColor: this.rgb(kind, id, rightSide, 'anchor.font.color', 'var(--balloon-anchor)'),
      cursorBackground: this.rgb(kind, id, rightSide, 'cursor.brush.color', 'var(--balloon-cursor-bg)'),
      cursorColor: this.rgb(kind, id, rightSide, 'cursor.font.color', 'var(--balloon-cursor-text)'),
      cursorStyle: (['square', 'underline', 'none'].includes(cursor) ? cursor : 'square') as BalloonStyle['cursorStyle'],
    };
  }
}
