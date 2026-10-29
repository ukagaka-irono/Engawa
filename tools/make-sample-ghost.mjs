// サンプルゴースト「ゆかりとちゅん」の .nar を作る。
// テキストは sample/engawa/ にあり、画像はここで描いて PNG にする。
//   node tools/make-sample-ghost.mjs  →  src/assets/engawa.nar (ビルドで index.html に埋め込まれる)
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'sample', 'engawa');
const outFile = join(root, 'src', 'assets', 'engawa.nar');

// ---------------------------------------------------------------- 描画

const SS = 4; // 1ピクセルあたり SS×SS 点で被覆率を取る

class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float64Array(w * h * 4); // 非乗算の RGBA (0..1)
  }

  /** inside(x, y) が真の部分を color で塗る。bbox は [x0, y0, x1, y1] */
  fill(inside, bbox, color) {
    const [r, g, b, a = 1] = color;
    const x0 = Math.max(0, Math.floor(bbox[0]));
    const y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(this.w, Math.ceil(bbox[2]));
    const y1 = Math.min(this.h, Math.ceil(bbox[3]));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let n = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) n++;
        }
        if (n) this.blend(x, y, r / 255, g / 255, b / 255, (a * n) / (SS * SS));
      }
    }
    return this;
  }

  blend(x, y, r, g, b, a) {
    const i = (y * this.w + x) * 4;
    const p = this.px;
    const da = p[i + 3];
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    p[i] = (r * a + p[i] * da * (1 - a)) / oa;
    p[i + 1] = (g * a + p[i + 1] * da * (1 - a)) / oa;
    p[i + 2] = (b * a + p[i + 2] * da * (1 - a)) / oa;
    p[i + 3] = oa;
  }

  ellipse(cx, cy, rx, ry, color) {
    return this.fill((x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, [cx - rx, cy - ry, cx + rx, cy + ry], color);
  }

  /** 輪郭付きの楕円 (先に一回り大きく輪郭色、その上に塗り色) */
  ellipseO(cx, cy, rx, ry, fill, line, t = 3) {
    this.ellipse(cx, cy, rx + t, ry + t, line);
    return this.ellipse(cx, cy, rx, ry, fill);
  }

  polygon(pts, color) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    return this.fill(inside, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], color);
  }

  /** 折れ線を太さ w で描く (端は丸) */
  stroke(pts, w, color, closed = false) {
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
    if (closed) segs.push([pts[pts.length - 1], pts[0]]);
    const h = w / 2;
    const inside = (x, y) =>
      segs.some(([[ax, ay], [bx, by]]) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
        return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= h * h;
      });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return this.fill(inside, [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h], color);
  }

  /** 円弧 (角度はラジアン、0 が右、π/2 が下) */
  arc(cx, cy, rx, ry, a0, a1, w, color) {
    const pts = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return this.stroke(pts, w, color);
  }

  /** 輪郭付きの多角形 */
  polygonO(pts, fill, line, t = 3) {
    this.stroke(pts, t * 2, line, true);
    return this.polygon(pts, fill);
  }

  roundRect(x0, y0, x1, y1, r, color) {
    const inside = (x, y) => {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    };
    return this.fill(inside, [x0, y0, x1, y1], color);
  }

  png() {
    const { w, h, px } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const o = y * (w * 4 + 1) + 1 + x * 4;
        const a = px[i + 3];
        raw[o] = Math.round(px[i] * 255);
        raw[o + 1] = Math.round(px[i + 1] * 255);
        raw[o + 2] = Math.round(px[i + 2] * 255);
        raw[o + 3] = Math.round(a * 255);
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const hex = (s, a = 1) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), a];

// ---------------------------------------------------------------- ゆかり (sakura, 200×250)

const SW = 200;
const SH = 250;
const EYE_L = [72, 150];
const EYE_R = [128, 150];

const PALETTES = {
  master: {
    body: hex('#fff3e1'), line: hex('#5c4535'), ear: hex('#f4b3aa'), eye: hex('#3a281e'), pupil: null,
    blush: hex('#f59d92', 0.5), mouth: hex('#5c4535'), nose: hex('#e98f86'), tongue: hex('#8a3c33'), spot: hex('#e7a565'),
  },
  kuro: {
    body: hex('#474753'), line: hex('#1d1d23'), ear: hex('#c58b8e'), eye: hex('#f1cf4a'), pupil: hex('#22201c'),
    blush: hex('#e48b93', 0.35), mouth: hex('#e8dccf'), nose: hex('#d68b91'), tongue: hex('#8a3c33'), spot: null,
  },
};

function sakuraBody(p) {
  const img = new Img(SW, SH);
  // しっぽ (体の後ろ)
  const tail = [[150, 222], [178, 206], [192, 176], [188, 146], [176, 128]];
  img.stroke(tail, 20, p.line).stroke(tail, 14, p.body);
  // 耳
  const earL = [[34, 104], [50, 34], [96, 76]];
  const earR = [[166, 104], [150, 34], [104, 76]];
  img.polygonO(earL, p.body, p.line).polygonO(earR, p.body, p.line);
  img.polygon([[46, 92], [54, 50], [80, 76]], p.ear).polygon([[154, 92], [146, 50], [120, 76]], p.ear);
  // 体
  img.ellipseO(100, 156, 80, 78, p.body, p.line);
  if (p.spot) img.ellipse(140, 104, 22, 16, p.spot); // 三毛のぶち
  // 前足
  img.ellipseO(72, 232, 17, 11, p.body, p.line).ellipseO(128, 232, 17, 11, p.body, p.line);
  img.stroke([[72, 226], [72, 238]], 2, p.line).stroke([[128, 226], [128, 238]], 2, p.line);
  return img;
}

function eyesOpen(img, p, r = 1) {
  for (const [x, y] of [EYE_L, EYE_R]) {
    img.ellipse(x, y, 8 * r, 11 * r, p.eye);
    if (p.pupil) img.ellipse(x, y, 3 * r, 9 * r, p.pupil);
    img.ellipse(x + 3 * r, y - 4 * r, 2.6 * r, 2.6 * r, hex('#ffffff'));
  }
}

function eyesHappy(img, p) {
  for (const [x, y] of [EYE_L, EYE_R]) img.arc(x, y + 4, 9, 8, Math.PI * 1.1, Math.PI * 1.9, 3.2, p.line);
}

function eyesClosed(img, p) {
  for (const [x, y] of [EYE_L, EYE_R]) img.arc(x, y - 2, 9, 6, Math.PI * 0.1, Math.PI * 0.9, 3.2, p.line);
}

function blush(img, p, strong = false) {
  const c = strong ? [...p.blush.slice(0, 3), Math.min(1, p.blush[3] * 1.8)] : p.blush;
  img.ellipse(50, 176, 13, 7, c).ellipse(150, 176, 13, 7, c);
}

function nose(img, p) {
  img.polygon([[95, 163], [105, 163], [100, 168]], p.nose);
}

function mouthOmega(img, p) {
  img.arc(94, 169, 6, 5, 0, Math.PI, 2.6, p.mouth).arc(106, 169, 6, 5, 0, Math.PI, 2.6, p.mouth);
}

function sakuraFace(id, p) {
  const img = new Img(SW, SH);
  switch (id) {
    case 0: // 通常
      blush(img, p), eyesOpen(img, p), nose(img, p), mouthOmega(img, p);
      break;
    case 1: // 照れ
      blush(img, p, true), eyesHappy(img, p), nose(img, p), mouthOmega(img, p);
      for (const x of [40, 46, 52]) img.stroke([[x, 170], [x - 3, 180]], 1.6, p.line);
      break;
    case 2: // 驚き
      blush(img, p), eyesOpen(img, p, 1.25), nose(img, p);
      img.ellipse(100, 178, 6, 7.5, p.line).ellipse(100, 178.5, 4, 5.5, p.tongue);
      break;
    case 3: // 困り
      blush(img, p), eyesOpen(img, p, 0.9), nose(img, p);
      img.stroke([[60, 132], [82, 126]], 3, p.line).stroke([[118, 126], [140, 132]], 3, p.line);
      img.stroke([[90, 176], [95, 173], [100, 176], [105, 173], [110, 176]], 2.6, p.mouth);
      break;
    case 4: // しょんぼり
      blush(img, p);
      for (const [x, y] of [EYE_L, EYE_R]) img.stroke([[x - 9, y], [x + 9, y + 2]], 3.2, p.line);
      img.stroke([[60, 128], [82, 133]], 2.6, p.line).stroke([[118, 133], [140, 128]], 2.6, p.line);
      nose(img, p);
      img.arc(100, 180, 8, 5, Math.PI * 1.15, Math.PI * 1.85, 2.6, p.mouth);
      break;
    case 5: // 笑顔
      blush(img, p, true), eyesHappy(img, p), nose(img, p);
      img.fill((x, y) => y >= 170 && ((x - 100) / 10) ** 2 + ((y - 170) / 10) ** 2 <= 1, [88, 168, 112, 182], p.tongue);
      img.stroke([[90, 170], [110, 170]], 2.4, p.line);
      break;
    case 6: // 目閉じ
      blush(img, p), eyesClosed(img, p), nose(img, p), mouthOmega(img, p);
      break;
    case 7: // 怒り
      blush(img, p), eyesOpen(img, p, 0.9), nose(img, p);
      img.stroke([[60, 126], [82, 134]], 3.2, p.line).stroke([[118, 134], [140, 126]], 3.2, p.line);
      img.arc(100, 181, 7, 4, Math.PI * 1.15, Math.PI * 1.85, 2.6, p.mouth);
      img.stroke([[150, 112], [158, 120]], 2.4, p.line).stroke([[158, 112], [150, 120]], 2.4, p.line);
      break;
  }
  return img;
}

/** まばたき用のまぶた (100: 半目, 101: 閉じ目) */
function sakuraBlink(closed, p) {
  const img = new Img(SW, SH);
  for (const [x, y] of [EYE_L, EYE_R]) {
    img.ellipse(x, y, 11, 13.5, p.body);
    if (closed) img.arc(x, y - 2, 9, 6, Math.PI * 0.1, Math.PI * 0.9, 3.2, p.line);
    else {
      img.fill((px, py) => py >= y && ((px - x) / 8) ** 2 + ((py - y) / 11) ** 2 <= 1, [x - 8, y, x + 8, y + 11], p.eye);
      img.stroke([[x - 9, y], [x + 9, y]], 3, p.line);
    }
  }
  return img;
}

/** 口パク (102) */
function sakuraTalk(p) {
  const img = new Img(SW, SH);
  img.ellipse(100, 174, 16, 9, p.body);
  nose(img, p);
  img.ellipse(100, 175, 6, 5, p.line).ellipse(100, 175.5, 4.2, 3.6, p.tongue);
  return img;
}

/** 着せ替え: リボン (3000) と麦わら帽子 (3001) */
function ribbon() {
  const img = new Img(SW, SH);
  const red = hex('#d2414b');
  const dark = hex('#7e1f28');
  img.polygonO([[150, 58], [130, 44], [132, 74]], red, dark, 2).polygonO([[150, 58], [172, 46], [168, 76]], red, dark, 2);
  img.ellipseO(150, 59, 6, 6, red, dark, 2);
  return img;
}

function strawHat() {
  const img = new Img(SW, SH);
  const straw = hex('#e8c977');
  const line = hex('#8f6b2c');
  const band = hex('#3e7fb8');
  img.ellipseO(100, 86, 82, 17, straw, line, 2.5);
  img.fill((x, y) => y <= 86 && ((x - 100) / 46) ** 2 + ((y - 86) / 44) ** 2 <= 1, [52, 40, 148, 88], line);
  img.fill((x, y) => y <= 85 && ((x - 100) / 43.5) ** 2 + ((y - 86) / 41.5) ** 2 <= 1, [55, 43, 145, 86], straw);
  img.fill((x, y) => y <= 85 && y >= 72 && ((x - 100) / 43.5) ** 2 + ((y - 86) / 41.5) ** 2 <= 1, [55, 70, 145, 86], band);
  return img;
}

// ---------------------------------------------------------------- ちゅん (kero, 130×124)

const KW = 130;
const KH = 124;
const K_EYES = [[50, 52], [80, 52]];

function keroPalette(name) {
  return name === 'kuro'
    ? { body: hex('#6b5a4c'), cap: hex('#4b3b30'), belly: hex('#cfc4b6'), line: hex('#25201c'), wing: hex('#56483d') }
    : { body: hex('#b07c52'), cap: hex('#7f5233'), belly: hex('#f4e8d6'), line: hex('#4a3122'), wing: hex('#8d603e') };
}

function keroBody(k) {
  const img = new Img(KW, KH);
  img.stroke([[52, 108], [48, 120]], 3, k.line).stroke([[78, 108], [82, 120]], 3, k.line); // 足
  img.ellipseO(65, 68, 52, 46, k.body, k.line);
  img.fill((x, y) => y < 50 && ((x - 65) / 52) ** 2 + ((y - 68) / 46) ** 2 <= 1, [13, 22, 117, 50], k.cap);
  img.ellipse(65, 86, 34, 26, k.belly);
  img.ellipse(36, 68, 13, 11, hex('#ffffff')).ellipse(94, 68, 13, 11, hex('#ffffff'));
  img.ellipse(36, 70, 5, 4, k.line).ellipse(94, 70, 5, 4, k.line); // ほっぺの黒い点
  img.ellipseO(18, 80, 11, 20, k.wing, k.line, 2).ellipseO(112, 80, 11, 20, k.wing, k.line, 2);
  return img;
}

function keroFace(id, k) {
  const img = new Img(KW, KH);
  const beak = hex('#3b302c');
  if (id === 11) {
    for (const [x, y] of K_EYES) img.arc(x, y + 3, 6, 5, Math.PI * 1.1, Math.PI * 1.9, 2.6, k.line);
  } else {
    const r = id === 12 ? 6.5 : 5;
    for (const [x, y] of K_EYES) img.ellipse(x, y, r, r, k.line).ellipse(x + 1.6, y - 1.8, 1.6, 1.6, hex('#ffffff'));
  }
  if (id === 12) {
    img.polygon([[58, 62], [72, 62], [65, 68]], beak).polygon([[59, 70], [71, 70], [65, 76]], beak);
  } else {
    img.polygon([[58, 62], [72, 62], [65, 73]], beak);
  }
  return img;
}

function keroBlink(k) {
  const img = new Img(KW, KH);
  for (const [x, y] of K_EYES) {
    img.ellipse(x, y, 7, 7, k.cap);
    img.arc(x, y - 1, 6, 4, Math.PI * 0.1, Math.PI * 0.9, 2.6, k.line);
  }
  return img;
}

// ---------------------------------------------------------------- バルーン

function balloonImage(w, h, tailRight) {
  const img = new Img(w, h);
  const paper = hex('#fffaf0');
  const line = hex('#8a6a4f');
  const inset = 14;
  const x0 = tailRight ? 2 : inset;
  const x1 = tailRight ? w - inset : w - 2;
  img.roundRect(x0, 2, x1, h - 2, 16, line).roundRect(x0 + 2.5, 4.5, x1 - 2.5, h - 4.5, 13.5, paper);
  const ty = 30;
  if (tailRight) {
    img.polygon([[x1 - 3, ty], [w - 1, ty + 10], [x1 - 3, ty + 20]], line);
    img.polygon([[x1 - 5, ty + 3], [w - 5, ty + 10], [x1 - 5, ty + 17]], paper);
  } else {
    img.polygon([[x0 + 3, ty], [1, ty + 10], [x0 + 3, ty + 20]], line);
    img.polygon([[x0 + 5, ty + 3], [5, ty + 10], [x0 + 5, ty + 17]], paper);
  }
  return img;
}

// ---------------------------------------------------------------- 組み立て

const files = {};
const put = (path, data) => (files[path] = data instanceof Uint8Array ? data : new Uint8Array(data));

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else put(relative(srcDir, p).replace(/\\/g, '/'), readFileSync(p));
  }
}
walk(srcDir);

for (const shell of ['master', 'kuro']) {
  const p = PALETTES[shell];
  const k = keroPalette(shell);
  const dir = `shell/${shell}/`;
  if (shell !== 'master') put(dir + 'surfaces.txt', files['shell/master/surfaces.txt']);
  put(dir + 'body.png', sakuraBody(p).png());
  for (let i = 0; i <= 7; i++) put(`${dir}face${i}.png`, sakuraFace(i, p).png());
  put(dir + 'surface100.png', sakuraBlink(false, p).png());
  put(dir + 'surface101.png', sakuraBlink(true, p).png());
  put(dir + 'surface102.png', sakuraTalk(p).png());
  put(dir + 'surface3000.png', ribbon().png());
  put(dir + 'surface3001.png', strawHat().png());
  put(dir + 'kero_body.png', keroBody(k).png());
  for (const i of [10, 11, 12]) put(`${dir}kero_face${i}.png`, keroFace(i, k).png());
  put(dir + 'surface1100.png', keroBlink(k).png());
}

put('balloon/engawa/balloons0.png', balloonImage(286, 184, true).png());
put('balloon/engawa/balloons1.png', balloonImage(286, 184, false).png());
put('balloon/engawa/balloonk0.png', balloonImage(232, 128, true).png());
put('balloon/engawa/balloonk1.png', balloonImage(232, 128, false).png());

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zipSync(files, { level: 9 }));
console.log(`wrote ${relative(root, outFile)} (${Object.keys(files).length} files)`);
