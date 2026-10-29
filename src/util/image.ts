export type Bitmap = HTMLCanvasElement;

/**
 * 透過の扱い (seriko.use_self_alpha / バルーンの use_self_alpha)。
 * - off:  左上のピクセルの色を透明色にする
 * - on:   アルファチャンネル (か .pna) を持つ画像はそれを使い、持たない画像は左上の色を透明色にする
 * - full: すべての画像をそのまま使う (アルファの無い画像は不透明)
 * - none: 透過処理をしない (\_b の opaque など)
 */
export type AlphaMode = 'off' | 'on' | 'full' | 'none';

export function parseAlphaMode(value: string | undefined): AlphaMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'full') return 'full';
  if (v === '1' || v === 'true') return 'on';
  return 'off';
}

/** 読み込んだ画像。使い終わったら close() する */
export interface DecodedImage {
  image: CanvasImageSource & { width: number; height: number };
  close(): void;
}

/** createImageBitmap の無いブラウザ (Safari 14 以前) では <img> で読む */
export async function decodeImage(data: Uint8Array): Promise<DecodedImage> {
  const blob = new Blob([data as BlobPart]);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('画像を読めませんでした'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return { image: img, close: () => {} };
}

/** PNG がアルファを持つか (カラータイプ 4/6、または tRNS チャンクがある) */
export function pngHasAlpha(data: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 33 || sig.some((b, i) => data[i] !== b)) return false;
  const colorType = data[25];
  if (colorType === 4 || colorType === 6) return true;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let p = 8; p + 8 <= data.length; ) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + len;
  }
  return false;
}

function toCanvas(img: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

/**
 * 伺かの透過規則を適用する。
 * - 同名の .pna があればその明度をアルファにする
 * - full、または on でアルファ付きの画像はそのまま使う
 * - off でも、左上のピクセルが既に透明なアルファ付き画像はそのまま使う (作者の意図が明らかなため)
 * - それ以外は左上のピクセルと同じ色を透明色にする
 */
export function applyTransparency(img: DecodedImage['image'], pna: DecodedImage['image'] | undefined, mode: AlphaMode, hasAlpha: boolean): Bitmap {
  const canvas = toCanvas(img);
  if (mode === 'none') return canvas;
  if (!pna && (mode === 'full' || (mode === 'on' && hasAlpha))) return canvas;
  const { width, height } = canvas;
  if (width === 0 || height === 0) return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  if (pna) {
    const mask = toCanvas(pna).getContext('2d')!.getImageData(0, 0, width, height).data;
    for (let i = 0; i < px.length; i += 4) px[i + 3] = mask[i]; // pna はグレースケールなので R を使う
  } else {
    if (px[3] === 0) return canvas;
    const [r, g, b] = [px[0], px[1], px[2]];
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === r && px[i + 1] === g && px[i + 2] === b) px[i + 3] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 画像ファイル (と同名 .pna) を読み、透過処理済みのキャンバスにする。 */
export async function loadTransparentImage(data: Uint8Array, pnaData: Uint8Array | undefined, mode: AlphaMode): Promise<Bitmap> {
  const [img, pna] = await Promise.all([decodeImage(data), pnaData ? decodeImage(pnaData) : Promise.resolve(undefined)]);
  try {
    return applyTransparency(img.image, pna?.image, mode, pngHasAlpha(data));
  } finally {
    img.close();
    pna?.close();
  }
}
