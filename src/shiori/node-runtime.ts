/**
 * SHIOLINK で Node.js のプログラムを動かす SHIORI・プラグイン (Narazaka の shiolinkjs を使うもの。『Nostrゅう』など) のための、
 * Worker の中の小さな Node.js。CommonJS の require (node_modules と package.json の exports・main)、process、
 * いくつかの組み込みモジュールだけを持つ。ブラウザにあるもの (fetch・WebSocket・crypto) はそのまま使い、
 * ws は WebSocket に、ベースウェアへの SSTP over HTTP (localhost:9801/api/sstp/v1) は Engawa の SSTP に差し替える。
 *
 * SHIOLINK の決まり (SHIOLINK.dll の readme): 標準入力に「*L:ディレクトリ」で load、「*S:ID」の後に要求を送ると、
 * プログラムは「*S:ID」をそのまま返してから応答を書く (要求・応答とも空行まで)。「*U:」で unload
 */

export interface NodeHost {
  /** ファイル (パスは normalizePath したもの。プラグイン・ゴーストのフォルダからの相対) */
  files: Map<string, Uint8Array>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** ファイルを書いた (セーブデータ) */
  write(path: string, data: Uint8Array): void;
  /** ベースウェアに SSTP を送り、応答を受け取る */
  sstp(request: string): Promise<string>;
}

type Listener = (...args: unknown[]) => void;

class EventEmitter {
  private readonly listeners = new Map<string, Listener[]>();
  on(name: string, fn: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  addListener(name: string, fn: Listener): this {
    return this.on(name, fn);
  }
  once(name: string, fn: Listener): this {
    const wrap: Listener = (...a) => {
      this.off(name, wrap);
      fn(...a);
    };
    return this.on(name, wrap);
  }
  off(name: string, fn: Listener): this {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
    return this;
  }
  removeListener(name: string, fn: Listener): this {
    return this.off(name, fn);
  }
  removeAllListeners(name?: string): this {
    if (name === undefined) this.listeners.clear();
    else this.listeners.delete(name);
    return this;
  }
  emit(name: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(name) ?? [];
    for (const fn of list) fn(...args);
    return list.length > 0;
  }
  setMaxListeners(): this {
    return this;
  }
}

/** パスは / で始まる絶対パス (/ がプラグイン・ゴーストのフォルダ) で扱う */
const pathModule = {
  sep: '/',
  delimiter: ';',
  normalize(p: string): string {
    const abs = p.startsWith('/');
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  },
  join(...parts: string[]): string {
    return pathModule.normalize(parts.filter(Boolean).join('/'));
  },
  resolve(...parts: string[]): string {
    let p = '';
    for (const part of parts) p = part.replace(/\\/g, '/').startsWith('/') || /^[A-Za-z]:/.test(part) ? part.replace(/^[A-Za-z]:/, '') : `${p}/${part}`;
    return pathModule.normalize(p.startsWith('/') ? p : `/${p}`);
  },
  dirname(p: string): string {
    const n = pathModule.normalize(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? (n.startsWith('/') ? '/' : '.') : n.slice(0, i);
  },
  basename(p: string, ext?: string): string {
    const b = pathModule.normalize(p).split('/').pop() ?? '';
    return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
  },
  extname(p: string): string {
    const b = pathModule.basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
  },
  isAbsolute(p: string): boolean {
    return /^([A-Za-z]:)?[\\/]/.test(p);
  },
  relative(from: string, to: string): string {
    const a = pathModule.resolve(from).split('/').filter(Boolean);
    const b = pathModule.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
};
Object.assign(pathModule, { posix: pathModule, win32: pathModule });

/** require の exports の条件 (Node と同じく、書かれた順に最初に当てはまるもの) */
const CONDITIONS = new Set(['require', 'node', 'default']);
function pickExport(e: unknown): string | undefined {
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) {
    for (const x of e) {
      const r = pickExport(x);
      if (r) return r;
    }
    return undefined;
  }
  if (e && typeof e === 'object') {
    // 当てはまる条件の中身から選べなければ、次の条件を見る (Node と同じ)
    for (const [k, v] of Object.entries(e)) {
      if (!CONDITIONS.has(k)) continue;
      const r = pickExport(v);
      if (r) return r;
    }
  }
  return undefined;
}

interface Module {
  exports: unknown;
  id: string;
  filename: string;
  loaded: boolean;
}

/** プログラムを始める。stdin に書くと、プログラムの process.stdin に届く */
export function startNode(host: NodeHost, argv: string[], opts: { globals?: boolean } = {}): { stdin(text: string): void; exited(): boolean; exit(): void } {
  const key = (p: string) => p.replace(/^\/+/, '').toLowerCase().normalize('NFC');
  const setImmediate = (fn: (...a: unknown[]) => void, ...a: unknown[]) => setTimeout(() => fn(...a), 0);
  const clearImmediate = (t: number) => clearTimeout(t);
  // ベースウェアへの SSTP over HTTP は Engawa の SSTP に送る
  const realFetch = globalThis.fetch.bind(globalThis);
  const nodeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://localhost/');
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) && url.port === '9801') {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      const body =
        typeof raw === 'string'
          ? raw
          : raw instanceof URLSearchParams
            ? raw.toString()
            : raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
              ? new TextDecoder().decode(raw as ArrayBuffer)
              : '';
      return new Response(await host.sstp(body.replace(/\r?\n/g, '\r\n')), { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return realFetch(input, init);
  };
  const has = (p: string) => host.files.has(key(p));
  const text = (p: string) => new TextDecoder().decode(host.files.get(key(p)));
  const cache = new Map<string, Module>();
  let exited = false;

  const stdin = Object.assign(new EventEmitter(), {
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    isTTY: false,
  });
  const stream = (write: (t: string) => void) =>
    Object.assign(new EventEmitter(), {
      write: (chunk: unknown, ...rest: unknown[]) => {
        write(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array));
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      },
      isTTY: false,
    });
  const proc = Object.assign(new EventEmitter(), {
    argv: ['/node.exe', ...argv],
    env: {} as Record<string, string>,
    platform: 'win32',
    version: 'v20.0.0',
    versions: { node: '20.0.0' },
    pid: 1,
    arch: 'x64',
    cwd: () => '/',
    chdir: () => undefined,
    exit: () => {
      exited = true;
    },
    nextTick: (fn: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => fn(...a)),
    hrtime: Object.assign(
      (prev?: [number, number]) => {
        const t = performance.now();
        const s = Math.floor(t / 1000);
        const ns = Math.floor((t % 1000) * 1e6);
        return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
    ),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    stdin,
    stdout: stream(host.stdout),
    stderr: stream(host.stderr),
  });

  const fsModule = {
    existsSync: (p: string) => has(pathModule.resolve(p)) || [...host.files.keys()].some((k) => k.startsWith(`${key(pathModule.resolve(p))}/`)),
    readFileSync: (p: string, opts?: string | { encoding?: string }) => {
      const k = key(pathModule.resolve(p));
      const data = host.files.get(k);
      if (!data) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      return enc ? new TextDecoder(enc === 'utf8' ? 'utf-8' : enc).decode(data) : data;
    },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      const k = key(pathModule.resolve(p));
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      host.files.set(k, bytes);
      host.write(k, bytes);
    },
    mkdirSync: () => undefined,
    readdirSync: (p: string) => {
      const head = key(pathModule.resolve(p));
      const names = new Set<string>();
      for (const k of host.files.keys()) if (!head || k.startsWith(`${head}/`)) names.add(k.slice(head ? head.length + 1 : 0).split('/')[0]);
      return [...names];
    },
  };
  Object.assign(fsModule, { promises: { readFile: async (p: string, o?: string) => fsModule.readFileSync(p, o), writeFile: async (p: string, d: string) => fsModule.writeFileSync(p, d) } });

  const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const builtins: Record<string, unknown> = {
    path: pathModule,
    events: Object.assign(EventEmitter, { EventEmitter, default: EventEmitter }),
    fs: fsModule,
    util: {
      inherits: (ctor: { prototype: object }, sup: { prototype: object }) => Object.setPrototypeOf(ctor.prototype, sup.prototype),
      promisify: (fn: (...a: unknown[]) => void) => (...a: unknown[]) => new Promise((res, rej) => fn(...a, (e: unknown, v: unknown) => (e ? rej(e) : res(v)))),
      deprecate: (fn: unknown) => fn,
      format: (...a: unknown[]) => a.map(String).join(' '),
      inspect: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
      TextEncoder,
      TextDecoder,
    },
    os: { EOL: '\r\n', platform: () => 'win32', homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'localhost', type: () => 'Windows_NT' },
    crypto: { webcrypto: crypto, getRandomValues: (a: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(a), randomBytes, randomUUID: () => crypto.randomUUID() },
    url: { URL, URLSearchParams },
    // ws は、ブラウザの WebSocket で足りる使い方 (new WebSocket(url)・onmessage など) をする
    ws: Object.assign(WebSocket, { WebSocket, default: WebSocket }),
    process: proc,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
  };

  /** ファイル・ディレクトリ (index.js・package.json) を探す。seen は package.json の main がたどり着く先の輪を止める */
  const asFile = (p: string, seen = new Set<string>()): string | undefined => {
    for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.json`]) if (has(c)) return c;
    if (has(`${p}/package.json`) && !seen.has(key(p))) {
      seen.add(key(p));
      let pkg: { main?: string; exports?: unknown } = {};
      try {
        pkg = JSON.parse(text(`${p}/package.json`)) as typeof pkg;
      } catch {
        // 読めない package.json は無いものとして、index.js を探す
      }
      const ex = pkg.exports && typeof pkg.exports === 'object' && '.' in pkg.exports ? (pkg.exports as Record<string, unknown>)['.'] : pkg.exports;
      const main = pickExport(ex) ?? pkg.main;
      if (main) {
        const r = asFile(pathModule.join(p, main), seen);
        if (r) return r;
      }
    }
    for (const c of [`${p}/index.js`, `${p}/index.json`]) if (has(c)) return c;
    return undefined;
  };

  const resolve = (spec: string, fromDir: string): string | undefined => {
    if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) return asFile(pathModule.resolve(fromDir, spec));
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const rest = parts.slice(name.split('/').length).join('/');
    for (let dir = fromDir; ; dir = pathModule.dirname(dir)) {
      const base = pathModule.join(dir, 'node_modules', name);
      if (has(`${base}/package.json`) || asFile(base)) {
        if (!rest) return asFile(base);
        const pkg = has(`${base}/package.json`) ? (JSON.parse(text(`${base}/package.json`)) as { exports?: Record<string, unknown> }) : {};
        const sub = pkg.exports && typeof pkg.exports === 'object' ? pickExport(pkg.exports[`./${rest}`]) : undefined;
        return asFile(pathModule.join(base, sub ?? rest));
      }
      if (dir === '/') return undefined;
    }
  };

  const load = (file: string): unknown => {
    // ファイルは大文字・小文字を区別しないので、キャッシュも同じ見方で引く
    const id = key(file);
    const cached = cache.get(id);
    if (cached) return cached.exports;
    const mod: Module = { exports: {}, id: file, filename: file, loaded: false };
    cache.set(id, mod);
    try {
      if (file.endsWith('.json')) {
        mod.exports = JSON.parse(text(file));
      } else {
        const dir = pathModule.dirname(file);
        const req = Object.assign((spec: string) => requireFrom(spec, dir), { resolve: (spec: string) => resolve(spec, dir) ?? spec, cache: {} });
        const code = text(file).replace(/^#!.*/, '');
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', 'process', 'global', 'fetch', 'setImmediate', 'clearImmediate', `${code}\n//# sourceURL=engawa-node:${file}`);
        fn.call(mod.exports, mod.exports, req, mod, file, dir, proc, globalThis, nodeFetch, setImmediate, clearImmediate);
      }
    } catch (e) {
      // 読み込みに失敗したモジュールは、Node と同じくキャッシュに残さない
      cache.delete(id);
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  };

  const requireFrom = (spec: string, fromDir: string): unknown => {
    const name = spec.replace(/^node:/, '');
    if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
    const file = resolve(spec, fromDir);
    if (!file) throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' });
    return load(file);
  };

  // プログラムから見える Node.js の大域の名前。Worker の中では大域に置く (モジュールには引数としても渡す)
  if (opts.globals) {
    const g = globalThis as unknown as Record<string, unknown>;
    g.process = proc;
    g.global = globalThis;
    g.setImmediate = setImmediate;
    g.clearImmediate = clearImmediate;
    globalThis.fetch = nodeFetch;
  }

  // node の引数のスクリプトは、node_modules の名前ではなく、いつもファイルのパス (node main.js も ./main.js と同じ)
  const entry = asFile(pathModule.resolve('/', argv[0]));
  if (!entry) throw Object.assign(new Error(`Cannot find module '${argv[0]}'`), { code: 'MODULE_NOT_FOUND' });
  load(entry);
  return {
    stdin: (t) => stdin.emit('data', t),
    exited: () => exited,
    exit: () => {
      if (exited) return;
      exited = true;
      proc.emit('beforeExit', 0);
      proc.emit('exit', 0);
    },
  };
}
