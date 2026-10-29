/** surfaces.txt (SERIKO) の解析。 */

export interface ElementDef {
  id: number;
  method: string;
  file: string;
  x: number;
  y: number;
}

export type CollisionShape = 'rect' | 'ellipse' | 'circle' | 'polygon';

export interface CollisionDef {
  id: number;
  shape: CollisionShape;
  coords: number[];
  name: string;
}

export interface PatternDef {
  method: string;
  surface: number;
  /** [最小, 最大] ミリ秒。範囲指定 `50-100` に対応するため */
  wait: [number, number];
  x: number;
  y: number;
  /** start / stop / alternativestart などの対象アニメーション ID */
  ids: number[];
}

export interface AnimationDef {
  id: number;
  intervals: string[];
  intervalArg: number;
  patterns: PatternDef[];
  /** option,exclusive。true は他のすべて、配列はその ID だけを止める */
  exclusive?: true | number[];
  /** option,background。ベースサーフェスの後ろに描く */
  background: boolean;
  collisions: CollisionDef[];
}

export interface SurfaceDef {
  id: number;
  elements: ElementDef[];
  collisions: CollisionDef[];
  animations: Map<number, AnimationDef>;
}

export interface SurfacesFile {
  surfaces: Map<number, SurfaceDef>;
  /** scope 名 (sakura / kero / char2…) → エイリアス (数字でも名前でもよい) → 実 ID 候補 */
  aliases: Map<string, Map<string, number[]>>;
  version: number;
}

interface Block {
  header: string;
  body: string[];
}

function stripComment(line: string): string {
  const t = line.trim();
  return t.startsWith('//') ? '' : t;
}

function splitBlocks(text: string): Block[] {
  const lines = text.split(/\r\n|\r|\n/).map(stripComment).filter((l) => l !== '');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    let header: string;
    if (line.includes('{')) {
      header = line.slice(0, line.indexOf('{')).trim();
      line = line.slice(line.indexOf('{') + 1).trim();
    } else if (lines[i + 1]?.startsWith('{')) {
      header = line;
      i++;
      line = lines[i].slice(1).trim();
    } else {
      i++;
      continue;
    }
    const body: string[] = [];
    for (;;) {
      const close = line.indexOf('}');
      if (close >= 0) {
        if (line.slice(0, close).trim()) body.push(line.slice(0, close).trim());
        break;
      }
      if (line) body.push(line);
      i++;
      if (i >= lines.length) break;
      line = lines[i];
    }
    i++;
    blocks.push({ header, body });
  }
  return blocks;
}

/** `0,2,5-9,!7` のような ID 指定を展開する。 */
export function parseIdSpec(spec: string): number[] {
  const include = new Set<number>();
  const exclude = new Set<number>();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const neg = part.startsWith('!');
    const body = neg ? part.slice(1) : part;
    const m = /^(\d+)(?:-(\d+))?$/.exec(body);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    for (let n = Math.min(from, to); n <= Math.max(from, to); n++) (neg ? exclude : include).add(n);
  }
  return [...include].filter((n) => !exclude.has(n));
}

function num(v: string | undefined, fallback = 0): number {
  const n = Number(v?.trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseWait(v: string | undefined, scale: number): [number, number] {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(v ?? '');
  if (m) return [Number(m[1]) * scale, Number(m[2]) * scale];
  const n = num(v) * scale;
  return [n, n];
}

/** `[1.2.3]` や `(1,2,3)`、または素の数値から ID 列を取り出す。 */
function parseIds(rest: string): number[] {
  const m = /[[(]([^\])]*)[\])]/.exec(rest);
  const src = m ? m[1] : rest.split(',')[0];
  return src
    .split(/[.,]/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

const ANIM_CONTROL = new Set(['start', 'stop', 'alternativestart', 'alternativestop', 'parallelstart', 'parallelstop']);

function newSurface(id: number): SurfaceDef {
  return { id, elements: [], collisions: [], animations: new Map() };
}

function anim(surface: SurfaceDef, id: number): AnimationDef {
  let a = surface.animations.get(id);
  if (!a) {
    a = { id, intervals: ['never'], intervalArg: 0, patterns: [], background: false, collisions: [] };
    surface.animations.set(id, a);
  }
  return a;
}

function parseCollision(id: number, parts: string[], ex: boolean): CollisionDef {
  if (!ex) {
    return { id, shape: 'rect', coords: parts.slice(1, 5).map((v) => num(v)), name: parts[5]?.trim() ?? '' };
  }
  const shape = (parts[2]?.trim().toLowerCase() || 'rect') as CollisionShape;
  return { id, shape, coords: parts.slice(3).map((v) => num(v)), name: parts[1]?.trim() ?? '' };
}

function parseSurfaceLine(s: SurfaceDef, line: string): void {
  const parts = line.split(',');
  const key = parts[0].trim().toLowerCase();
  let m: RegExpExecArray | null;

  if ((m = /^element(\d+)$/.exec(key))) {
    s.elements.push({
      id: Number(m[1]),
      method: parts[1]?.trim().toLowerCase() ?? 'overlay',
      file: parts[2]?.trim() ?? '',
      x: num(parts[3]),
      y: num(parts[4]),
    });
    s.elements.sort((a, b) => a.id - b.id);
  } else if ((m = /^collision(ex)?(\d+)$/.exec(key))) {
    s.collisions.push(parseCollision(Number(m[2]), parts, !!m[1]));
  } else if ((m = /^animation(\d+)\.interval$/.exec(key)) || (m = /^(\d+)interval$/.exec(key))) {
    const a = anim(s, Number(m[1]));
    a.intervals = (parts[1] ?? 'never').trim().toLowerCase().split('+');
    a.intervalArg = num(parts[2]);
  } else if ((m = /^animation(\d+)\.option$/.exec(key)) || (m = /^(\d+)option$/.exec(key))) {
    // exclusive / exclusive,(1,3,5) / background、+ で組み合わせ可
    const a = anim(s, Number(m[1]));
    const rest = parts.slice(1).join(',');
    if (/exclusive/i.test(rest)) {
      const ids = /\(([^)]*)\)/.exec(rest);
      a.exclusive = ids ? parseIds(`(${ids[1]})`) : true;
    }
    a.background = /background/i.test(rest);
  } else if ((m = /^animation(\d+)\.collision(ex)?(\d+)$/.exec(key))) {
    anim(s, Number(m[1])).collisions.push(parseCollision(Number(m[3]), parts, !!m[2]));
  } else if ((m = /^animation(\d+)\.pattern(\d+)$/.exec(key))) {
    // 新書式: method, surface, wait(ms), x, y
    const method = parts[1]?.trim().toLowerCase() ?? 'overlay';
    const a = anim(s, Number(m[1]));
    a.patterns[Number(m[2])] = ANIM_CONTROL.has(method)
      ? { method, surface: -1, wait: parseWait(parts[3], 1), x: 0, y: 0, ids: parseIds(parts.slice(2).join(',')) }
      : { method, surface: num(parts[2], -1), wait: parseWait(parts[3], 1), x: num(parts[4]), y: num(parts[5]), ids: [] };
  } else if ((m = /^(\d+)pattern(\d+)$/.exec(key))) {
    // 旧書式: surface, wait(10ms 単位), method, x, y
    const method = parts[3]?.trim().toLowerCase() ?? 'overlay';
    const a = anim(s, Number(m[1]));
    a.patterns[Number(m[2])] = {
      method,
      surface: num(parts[1], -1),
      wait: parseWait(parts[2], 10),
      x: num(parts[4]),
      y: num(parts[5]),
      ids: ANIM_CONTROL.has(method) ? parseIds(parts.slice(4).join(',')) : [],
    };
  }
}

function scopeName(prefix: string): string {
  const p = prefix.toLowerCase();
  if (p === '' || p === 'sakura') return 'sakura';
  return p;
}

/**
 * @param exists surface.append で、定義の無い ID を足すかどうかの判定 (surfaceN.png があるか)。
 *   append は既にあるサーフェスにだけ追加する (ukadoc)
 */
export function parseSurfaces(text: string, into?: SurfacesFile, exists: (id: number) => boolean = () => true): SurfacesFile {
  const file: SurfacesFile = into ?? { surfaces: new Map(), aliases: new Map(), version: 0 };
  // append は後ろに書かれた surface ブロックにも効くよう、通常のブロックを全部読んでから適用する
  const blocks = splitBlocks(text);
  const isAppend = (b: Block) => /^surface\.append/i.test(b.header.trim());
  for (const { header, body } of [...blocks.filter((b) => !isAppend(b)), ...blocks.filter(isAppend)]) {
    const h = header.trim();
    const lower = h.toLowerCase();
    if (lower === 'descript') {
      for (const line of body) {
        const [k, v] = line.split(',');
        if (k.trim().toLowerCase() === 'version') file.version = num(v);
      }
      continue;
    }
    const alias = /^(?:(\w+)\.)?surface\.alias$/i.exec(h);
    if (alias) {
      const scope = scopeName(alias[1] ?? '');
      const map = file.aliases.get(scope) ?? new Map<string, number[]>();
      for (const line of body) {
        const m = /^([^,]+?)\s*,\s*\[([^\]]*)\]/.exec(line);
        if (m) map.set(m[1].trim(), m[2].split(',').map((v) => num(v)));
      }
      file.aliases.set(scope, map);
      continue;
    }
    // surface0,2-5,!3 のほか、MATERIA 式の surface0,surface1 も受ける
    const sm = /^surface(\.append)?\s*(.*)$/i.exec(h);
    if (!sm) continue;
    const spec = sm[2].replace(/surface(?:\.append)?/gi, '');
    if (!/^[\d,\-!\s]+$/.test(spec)) continue;
    const append = !!sm[1];
    for (const id of parseIdSpec(spec)) {
      let s = file.surfaces.get(id);
      if (!s) {
        if (append && !exists(id)) continue;
        s = newSurface(id);
        file.surfaces.set(id, s);
      }
      for (const line of body) parseSurfaceLine(s, line);
    }
  }
  // 疎な pattern 配列を詰める
  for (const s of file.surfaces.values()) {
    for (const a of s.animations.values()) a.patterns = a.patterns.filter(Boolean);
  }
  return file;
}

export function hitCollision(collisions: CollisionDef[], x: number, y: number): CollisionDef | undefined {
  return collisions.find((c) => {
    const k = c.coords;
    switch (c.shape) {
      case 'rect':
        return x >= Math.min(k[0], k[2]) && x <= Math.max(k[0], k[2]) && y >= Math.min(k[1], k[3]) && y <= Math.max(k[1], k[3]);
      case 'ellipse': {
        const cx = (k[0] + k[2]) / 2;
        const cy = (k[1] + k[3]) / 2;
        const rx = Math.abs(k[2] - k[0]) / 2;
        const ry = Math.abs(k[3] - k[1]) / 2;
        return rx > 0 && ry > 0 && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      }
      case 'circle':
        return (x - k[0]) ** 2 + (y - k[1]) ** 2 <= k[2] ** 2;
      case 'polygon': {
        let inside = false;
        for (let i = 0, j = k.length / 2 - 1; i < k.length / 2; j = i++) {
          const xi = k[i * 2], yi = k[i * 2 + 1], xj = k[j * 2], yj = k[j * 2 + 1];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }
      default:
        return false;
    }
  });
}
