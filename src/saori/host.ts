import type { EmscriptenFS } from '../shiori/native-engines';
import { builtinSaori } from './detect';
import { buildSaoriResponse, matchResponseCharset, parseSaoriRequest, type SaoriRequest, type SaoriResult } from './protocol';

/**
 * SHIORI の Worker の中の、SAORI の置き場。
 * WebAssembly にした SHIORI が SAORI の DLL を開くと (dlopen・LoadLibrary)、native/shim/engawa_saori.c が
 * Module.engawaSaori (bridge) を呼ぶ。DLL のパスから、JavaScript や WebAssembly で作り直した SAORI を探して渡す。
 */

/** DLL と同じ形の SAORI。要求と応答はバイト列のまま (文字コードは SAORI が決める) */
export interface SaoriModule {
  /** dir は DLL のあるディレクトリ (末尾に /) */
  load(dir: string): boolean;
  request(req: Uint8Array): Uint8Array | undefined;
  unload(): boolean;
}

/** JavaScript で作り直した SAORI。要求を読み、応答を書くのは fromJs が受け持つ */
export interface JsSaori {
  execute(req: SaoriRequest): SaoriResult;
  load?(dir: string): void;
  unload?(): void;
}

/** JsSaori を DLL と同じ形にする。GET Version には 200 OK だけを返す */
export function fromJs(saori: JsSaori): SaoriModule {
  return {
    load(dir) {
      saori.load?.(dir);
      return true;
    },
    request(bytes) {
      const req = parseSaoriRequest(bytes);
      if (/^GET Version$/i.test(req.method)) return buildSaoriResponse({ status: 200 }, req.charset);
      if (!/^EXECUTE$/i.test(req.method)) return buildSaoriResponse({ status: 400 }, req.charset);
      return buildSaoriResponse(saori.execute(req), req.charset);
    },
    unload() {
      saori.unload?.();
      return true;
    },
  };
}

/** 開いた DLL のパス (ファイルシステムの上の本当の綴り) と中身から、SAORI を作る。知らないものなら undefined */
export type SaoriResolver = (path: string, data: Uint8Array) => SaoriModule | undefined;

/** engawa_saori.c が呼ぶもの。番号 (id) は 1 から SLOTS まで */
export interface SaoriBridge {
  open(path: Uint8Array): number;
  load(id: number, dir: Uint8Array): number;
  request(id: number, req: Uint8Array): Uint8Array | null;
  unload(id: number): number;
  close(id: number): void;
}

/** engawa_saori.c の SLOTS と同じ */
const SLOTS = 32;

interface Opened {
  path: string;
  module: SaoriModule;
  /** LoadLibrary と同じく、同じ DLL を何度開いても同じ持ち手を返し、閉じた数を数える */
  refs: number;
}

/** 「C:\ghost\master\saori\x.dll」「saori/./x.dll」などを、cwd からの絶対パス (/ 区切り) にする */
export function normalizePath(path: string, cwd: string): string {
  const unix = path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '');
  const parts: string[] = [];
  for (const part of (unix.startsWith('/') ? unix : `${cwd}/${unix}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Windows と同じく、大文字と小文字を区別せずにファイルを探す。見つかれば本当の綴りのパス */
export function findFile(fs: EmscriptenFS, path: string): string | undefined {
  let dir = '';
  for (const part of path.split('/').filter(Boolean)) {
    const here = dir || '/';
    if (!fs.analyzePath(here).exists || !fs.isDir(fs.stat(here).mode)) return undefined;
    const lower = part.toLowerCase();
    const name = fs.readdir(here).find((n) => n === part) ?? fs.readdir(here).find((n) => n.toLowerCase() === lower);
    if (!name) return undefined;
    dir = `${dir}/${name}`;
  }
  return dir && fs.isFile(fs.stat(dir).mode) ? dir : undefined;
}

/** DLL のパスは、POSIX 版の SHIORI なら UTF-8、華和梨 7 などは Shift_JIS のバイト列 */
function decodePath(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

export class SaoriHost {
  private readonly slots: (Opened | undefined)[] = [];
  /** 一度作った SAORI は、閉じても取っておく (WebAssembly のものは作り直せないので) */
  private readonly made = new Map<string, SaoriModule>();

  constructor(
    private readonly fs: EmscriptenFS,
    private readonly cwd: string,
    private readonly resolve: SaoriResolver,
    private readonly log: (message: string) => void,
  ) {}

  /** 開いている SAORI をすべて unload する (SHIORI が unload しないまま終わるとき) */
  unloadAll(): void {
    for (const s of this.slots) if (s) this.guard(s.path, () => s.module.unload(), false);
    this.slots.length = 0;
  }

  readonly bridge: SaoriBridge = {
    open: (pathBytes) => {
      const asked = normalizePath(decodePath(pathBytes), this.cwd);
      // ninix-saori はゴーストが同梱しない (ベースウェアの側にある) ので、無くてもその名前なら開く
      const path = findFile(this.fs, asked) ?? (builtinSaori(asked) ? asked : undefined);
      if (!path) {
        this.log(`SAORI: ${asked} が見つかりません`);
        return 0;
      }
      const index = this.slots.findIndex((s) => s?.path === path);
      if (index >= 0) {
        this.slots[index]!.refs++;
        return index + 1;
      }
      let module = this.made.get(path);
      if (!module) {
        module = this.guard(path, () => this.resolve(path, this.fs.analyzePath(path).exists ? this.fs.readFile(path) : new Uint8Array(0)), undefined);
        if (!module) {
          this.log(`SAORI: ${path} はブラウザでは使えません`);
          return 0;
        }
        this.made.set(path, module);
      }
      let free = 0;
      while (free < SLOTS && this.slots[free]) free++;
      if (free === SLOTS) {
        this.log('SAORI: 同時に開ける数を超えました');
        return 0;
      }
      this.slots[free] = { path, module, refs: 1 };
      return free + 1;
    },
    load: (id, dir) => {
      const s = this.slots[id - 1];
      return s && this.guard(s.path, () => s.module.load(decodePath(dir)), false) ? 1 : 0;
    },
    request: (id, req) => {
      const s = this.slots[id - 1];
      const res = s && this.guard(s.path, () => s.module.request(req), undefined);
      return res ? matchResponseCharset(req, res) : null;
    },
    unload: (id) => {
      const s = this.slots[id - 1];
      return s && this.guard(s.path, () => s.module.unload(), false) ? 1 : 0;
    },
    close: (id) => {
      const s = this.slots[id - 1];
      if (s && --s.refs <= 0) this.slots[id - 1] = undefined;
    },
  };

  /** SAORI の中の例外を SHIORI (wasm) に投げ返さない */
  private guard<T>(path: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      this.log(`SAORI ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  }
}
