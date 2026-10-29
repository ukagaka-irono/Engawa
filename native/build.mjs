// DLL 製 SHIORI を WebAssembly にする。
//   node native/build.mjs [engine...]   (何も書かなければ全部)
// 各 SHIORI のソースを固定のコミットで native/.src/ に取ってきて、Emscripten でビルドし、
//   src/assets/shiori/<engine>.mjs      (Emscripten が作る読み込み用の JS)
//   src/assets/shiori/<engine>.wasm.gz  (本体。ビルドで index.html に埋め込まれる)
// を書き出す。出来上がったものはリポジトリに入れるので、Engawa をビルドするだけなら Emscripten は要らない。
//
// Emscripten は 5.0.x を使う (6.0 以降は Safari 14.1 / 15 より古いブラウザ向けに出力できない)。
// 場所は環境変数 EMSDK (既定は ~/emsdk)。
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ENGINES } from './engines.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(root, 'native');
const outDir = join(root, 'src', 'assets', 'shiori');

// ---------------------------------------------------------------- Emscripten

const emsdk = process.env.EMSDK ?? join(homedir(), 'emsdk');
const emConfig = join(emsdk, '.emscripten');
const emDir = join(emsdk, 'upstream', 'emscripten');
const python = process.platform === 'win32' ? findPython() : 'python3';
const EM_VERSION = /^"?5\.0\./;

function findPython() {
  const base = join(emsdk, 'python');
  if (!existsSync(base)) return 'python';
  const v = execFileSync('cmd', ['/c', 'dir', '/b', base], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  return join(base, v, 'python.exe');
}

function checkEmscripten() {
  const version = existsSync(join(emDir, 'emscripten-version.txt')) ? readFileSync(join(emDir, 'emscripten-version.txt'), 'utf-8').trim() : '';
  if (!EM_VERSION.test(version)) {
    throw new Error(`Emscripten 5.0.x が必要です (見つかったのは ${version || 'なし'}): ${emsdk} で "emsdk install 5.0.7" と "emsdk activate 5.0.7"`);
  }
  return version.replace(/"/g, '');
}

const env = { ...process.env, EM_CONFIG: emConfig, EMSDK: emsdk };

function run(tool, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(python, [join(emDir, `${tool}.py`), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${tool} ${args.slice(-3).join(' ')}\n${out}`))));
  });
}

/** 同時に jobs 個まで走らせる */
async function pool(items, jobs, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// ---------------------------------------------------------------- ソース

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** native/.src/<name> を指定のコミットにする (浅く取る。サブモジュールも) */
function fetchSource(engine) {
  return fetchRepo(engine.name, engine.name, engine.repo, engine.commit);
}

/** native/.src/<dir> を repo の commit にする */
function fetchRepo(label, name, repo, commit) {
  const dir = join(nativeDir, '.src', name);
  const engine = { name: label, repo, commit };
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    git(['remote', 'add', 'origin', engine.repo], dir);
  }
  let head = '';
  try {
    head = git(['rev-parse', 'HEAD'], dir);
  } catch {
    // まだ何も取っていない
  }
  if (head !== engine.commit) {
    console.log(`[${engine.name}] ${engine.repo} @ ${engine.commit.slice(0, 7)} を取得`);
    git(['-c', 'core.longpaths=true', 'fetch', '-q', '--depth', '1', 'origin', engine.commit], dir);
    git(['-c', 'core.longpaths=true', 'checkout', '-q', '--force', 'FETCH_HEAD'], dir);
    if (existsSync(join(dir, '.gitmodules'))) git(['-c', 'core.longpaths=true', 'submodule', 'update', '-q', '--init', '--depth', '1', '--recursive'], dir);
  }
  return dir;
}

/** ブラウザで動かすための小さな直し (engines.mjs の edits)。直す場所がちょうど1か所でなければ止める */
function applyEdits(text, edits, file) {
  for (let [search, replace] of edits) {
    // Windows の git は改行を CRLF にして取り出すことがあるので、どちらの改行でも直せるようにする
    if (!text.includes(search) && search.includes('\n') && text.includes(search.replace(/\n/g, '\r\n'))) {
      search = search.replace(/\n/g, '\r\n');
      replace = replace.replace(/\n/g, '\r\n');
    }
    const count = text.split(search).length - 1;
    if (count !== 1) throw new Error(`${file}: 直す場所が ${count} か所あります: ${search}`);
    text = text.replace(search, () => replace);
  }
  return text;
}

/**
 * Shift_JIS / EUC-JP のソースを UTF-8 にして build/ に置く (clang は UTF-8 以外の文字列リテラルを受け付けない)。
 * #line で、エラーの行が元のファイルを指すようにする。変換できないバイトがあれば止める。
 */
function convertSource(src, file, encoding, buildDir, edits = [], always = false) {
  const from = join(src, file);
  if ((!encoding || encoding === 'utf-8') && edits.length === 0 && !always) return from;
  // 変換しないファイル (華和梨 7 の Shift_JIS のまま扱うソースなど) は、latin1 で読み書きしてバイトをそのまま残す
  const binary = !encoding;
  const text = applyEdits(binary ? readFileSync(from).toString('latin1') : new TextDecoder(encoding, { fatal: true }).decode(readFileSync(from)), edits, file);
  const to = join(buildDir, 'utf8src', file);
  mkdirSync(dirname(to), { recursive: true });
  const content = Buffer.from(`#line 1 "${from.replace(/\\/g, '/')}"\n${text}`, binary ? 'latin1' : 'utf-8');
  if (!existsSync(to) || !readFileSync(to).equals(content)) writeFileSync(to, content);
  return to;
}

// ---------------------------------------------------------------- Rust

const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');

/**
 * Rust 製の SHIORI (engines.mjs の rust) を、Emscripten 向けの静的ライブラリにする。リンクは C++ のものと同じく em++ で行う。
 * クレートは build/ に写し、edits を当て、Windows 専用の依存 (winapi) は native/shim/rust-winapi に差し替える。
 *
 * 今の Rust の Emscripten 向けの標準ライブラリは wasm の例外処理 (Safari 15.2 から) を使うので、そのままでは
 * Safari 12 で読めない。nightly の -Zbuild-std で、標準ライブラリごと panic=abort で作り直す (例外処理を使わない)。
 * そのため Rust 製の SHIORI がパニックすると、捕まえずにその SHIORI が止まる。
 * 要るもの: rustup toolchain install nightly --component rust-src
 */
async function buildRust(engine, src, buildDir) {
  if (!existsSync(cargo)) throw new Error(`Rust (cargo) が見つかりません: ${cargo}。rustup で入れ、"rustup target add wasm32-unknown-emscripten"`);
  const crate = join(buildDir, 'crate');
  rmSync(crate, { recursive: true, force: true });
  cpSync(src, crate, { recursive: true, filter: (p) => !/[\\/](\.git|target)$/.test(p) });
  for (const [file, edits] of Object.entries(engine.edits ?? {})) {
    writeFileSync(join(crate, file), applyEdits(readFileSync(join(crate, file), 'utf-8'), edits, file));
  }
  const patches = Object.entries(engine.rust.patch ?? {})
    .map(([name, dir]) => `${name} = { path = ${JSON.stringify(join(nativeDir, 'shim', dir).replace(/\\/g, '/'))} }`)
    .join('\n');
  if (patches) writeFileSync(join(crate, 'Cargo.toml'), `${readFileSync(join(crate, 'Cargo.toml'), 'utf-8')}\n\n[patch.crates-io]\n${patches}\n`);
  console.log(`[${engine.name}] cargo build (wasm32-unknown-emscripten)`);
  const target = join(buildDir, 'target');
  await new Promise((resolve, reject) => {
    const p = spawn(
      cargo,
      [
        '+nightly',
        'rustc',
        '-Zbuild-std=std,panic_abort',
        '--release',
        '--lib',
        '--target',
        'wasm32-unknown-emscripten',
        '--crate-type',
        'staticlib',
        ...(engine.rust.package ? ['-p', engine.rust.package] : []),
      ],
      { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, RUSTFLAGS: '-Cpanic=abort', CARGO_PROFILE_RELEASE_PANIC: 'abort' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`cargo\n${out.slice(-6000)}`))));
  });
  return join(target, 'wasm32-unknown-emscripten', 'release', `lib${engine.rust.lib}.a`);
}

// ---------------------------------------------------------------- ライセンス

/**
 * 組み込む SHIORI と、その中に入る他のコードのライセンスの写しを、src/assets/shiori/<engine>.LICENSES.txt に書く。
 * BSD・MIT などは、バイナリを配るときにも著作権表示と条文を一緒に配る決まりなので、Engawa の「ライセンス」で見せる。
 * engines.mjs の licenses は { title, file, encoding?, from?, to? } (from・to はファイルの一部だけを使うとき)。
 */
function licenseText(spec, locate) {
  const [root, rel] = locate(spec.file);
  const bytes = readFileSync(join(root, rel));
  let text = spec.encoding ? new TextDecoder(spec.encoding).decode(bytes) : bytes.toString('utf-8');
  if (spec.from) {
    const i = text.indexOf(spec.from);
    if (i < 0) throw new Error(`${spec.file} にライセンスの始まり (${spec.from}) がありません`);
    text = text.slice(i);
  }
  if (spec.to) {
    const j = text.indexOf(spec.to);
    if (j >= 0) text = text.slice(0, j);
  }
  return text.replace(/\r\n?/g, '\n').trim();
}

const section = (title, text) => `${'-'.repeat(72)}\n${title}\n${'-'.repeat(72)}\n\n${text}\n`;

/** Rust の依存クレート (wasm に入るもの) のライセンス。ビルドのときだけ使うクレート (build・proc-macro) は除く */
function rustLicenses(crate) {
  const meta = JSON.parse(
    execFileSync(cargo, ['+nightly', 'metadata', '--format-version', '1', '--filter-platform', 'wasm32-unknown-emscripten'], {
      cwd: crate,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env,
    }),
  );
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      const pkg = packages.get(dep.pkg);
      if (pkg.targets.some((t) => t.kind.includes('proc-macro'))) continue;
      queue.push(dep.pkg);
    }
  }
  const out = [];
  for (const id of [...seen].sort()) {
    const pkg = packages.get(id);
    if (id === meta.resolve.root || pkg.source === null) continue; // 本体と、native/shim の代わりのクレート
    const dir = dirname(pkg.manifest_path);
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|unlicense|notice)/i.test(f));
    // MIT を選べるものは MIT の条文だけを載せる
    const mit = /\bMIT\b/.test(pkg.license ?? '') && files.find((f) => /^licen[cs]e-mit/i.test(f));
    const chosen = mit ? [mit] : files;
    const text = chosen.length ? chosen.map((f) => readFileSync(join(dir, f), 'utf-8').replace(/\r\n?/g, '\n').trim()).join('\n\n') : `(ライセンス: ${pkg.license ?? '不明'})`;
    out.push(section(`${pkg.name} ${pkg.version} (Rust のクレート、${pkg.license ?? 'ライセンス不明'})`, text));
  }
  return out;
}

function writeLicenses(engine, locate, extra = []) {
  const parts = [`${engine.label} — ${engine.repo} @ ${engine.commit}\n`];
  for (const spec of engine.licenses ?? []) parts.push(section(spec.title, licenseText(spec, locate)));
  parts.push(...extra);
  writeFileSync(join(outDir, `${engine.name}.LICENSES.txt`), parts.join('\n'));
}

/** すべての SHIORI に入る Emscripten の実行時ライブラリ (musl・libc++ など) と、いくつかのものが参照する Apache License 2.0 の条文 */
function writeCommonLicenses() {
  const apache = join(rustToolchain('nightly'), 'share', 'doc', 'cargo', 'LICENSE-APACHE');
  writeFileSync(
    join(outDir, 'COMMON.LICENSES.txt'),
    [
      section('Emscripten (WebAssembly にするときに入る実行時ライブラリ: musl・libc++・compiler-rt など)', readFileSync(join(emDir, 'LICENSE'), 'utf-8').replace(/\r\n?/g, '\n').trim()),
      section('Apache License 2.0 (Gumbo・Rust の標準ライブラリなどの条文)', readFileSync(apache, 'utf-8').replace(/\r\n?/g, '\n').trim()),
    ].join('\n'),
  );
}

function rustToolchain(channel) {
  const base = join(process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'), 'toolchains');
  const name = readdirSync(base).find((d) => d.startsWith(`${channel}-`));
  if (!name) throw new Error(`Rust の ${channel} が見つかりません (${base})`);
  return join(base, name);
}

// ---------------------------------------------------------------- ビルド

/** すべての SHIORI に共通のリンク設定。SHIORI の DLL と同じ load / request / unload を出す */
const COMMON_LDFLAGS = [
  '-sMODULARIZE',
  '-sEXPORT_ES6',
  '-sENVIRONMENT=worker',
  '-sALLOW_MEMORY_GROWTH',
  '-sSTACK_SIZE=4MB',
  '-sFORCE_FILESYSTEM',
  '-sEXIT_RUNTIME=0',
  // Safari 12.2 (iOS 12.2) 以降でも動く wasm と JS にする
  '-sMIN_SAFARI_VERSION=120200',
  '-sMIN_FIREFOX_VERSION=78',
  '-sMIN_CHROME_VERSION=74',
  '-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP32',
  '-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr',
];

/**
 * native/shim/engawa_iconv.c が使う CP932 の表を作る。Encoding Standard の Shift_JIS デコーダ (Node の TextDecoder)
 * で全2バイト文字を読む。逆引きで同じ文字が複数の符号を持つときは、src/util/charset-encode.ts と同じく
 * 先に見つかった方、ただし NEC 選定 IBM 拡張 (0xED-0xEE) より IBM 拡張 (0xFA-0xFC) を選ぶ。
 */
function writeCp932Table() {
  const dir = join(nativeDir, '.build', 'shim');
  const file = join(dir, 'cp932_table.h');
  if (existsSync(file)) return dir;
  const dec = new TextDecoder('shift_jis');
  const decode = new Uint16Array(188 * 60);
  const encode = new Map();
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const s = dec.decode(Uint8Array.of(lead, trail));
      if (s.length !== 1 || s === '�') continue;
      const cp = s.charCodeAt(0);
      const code = (lead << 8) | trail;
      decode[(lead - (lead < 0xa0 ? 0x81 : 0xc1)) * 188 + (trail - (trail < 0x7f ? 0x40 : 0x41))] = cp;
      const known = encode.get(cp);
      if (known === undefined || (lead >= 0xfa && (known >> 8 === 0xed || known >> 8 === 0xee))) encode.set(cp, code);
    }
  }
  const pairs = [...encode].sort((a, b) => a[0] - b[0]);
  const rows = (values, per) => values.reduce((out, v, i) => out + (i % per ? ' ' : '\n  ') + v + ',', '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `/* native/build.mjs が作った CP932 の表。手で編集しない */\n` +
      `static const unsigned short cp932_dec[${decode.length}] = {${rows([...decode], 16)}\n};\n` +
      `static const unsigned short cp932_enc[${pairs.length}][2] = {${rows(pairs.map(([u, c]) => `{${u}, ${c}}`), 8)}\n};\n`,
  );
  return dir;
}

async function build(engine) {
  const version = checkEmscripten();
  const tableDir = writeCp932Table();
  const src = fetchSource(engine);
  const buildDir = join(nativeDir, '.build', engine.name);
  mkdirSync(buildDir, { recursive: true });
  // SHIORI のリポジトリに入っていない依存 (kagari の Lua・sol2 など)。engines.mjs では "@名前/パス" で指す
  const deps = Object.fromEntries((engine.deps ?? []).map((d) => [d.name, fetchRepo(engine.name, `${engine.name}--${d.name}`, d.repo, d.commit)]));
  // 依存に直しがあれば (edits の "@名前/パス")、build/ に写してから直す
  for (const name of Object.keys(deps)) {
    const own = Object.entries(engine.edits ?? {}).filter(([f]) => f.startsWith(`@${name}/`));
    if (own.length === 0) continue;
    const copy = join(buildDir, 'deps', name);
    rmSync(copy, { recursive: true, force: true });
    cpSync(deps[name], copy, { recursive: true, filter: (p) => !/[\\/]\.git$/.test(p) });
    for (const [file, edits] of own) {
      const path = join(copy, file.slice(name.length + 2));
      writeFileSync(path, applyEdits(readFileSync(path, 'utf-8'), edits, file));
    }
    deps[name] = copy;
  }
  /** "@名前/パス" を [そのリポジトリ, パス] に、それ以外を [SHIORI のリポジトリ, パス] にする */
  const locate = (path) => {
    const m = /^@([\w-]+)\/(.*)$/.exec(path);
    if (!m) return [src, path];
    if (!deps[m[1]]) throw new Error(`知らない依存: ${m[1]}`);
    return [deps[m[1]], m[2]];
  };
  // ヘッダにも Shift_JIS などの文字列があるもの (engines.mjs の headerDirs) は、ヘッダも UTF-8 の写しを作り、そちらを先に探す
  const headerDirs = engine.headerDirs ?? [];
  for (const dir of headerDirs) {
    for (const name of readdirSync(join(src, dir))) {
      const file = dir === '.' ? name : `${dir}/${name}`;
      if (/\.(h|hpp)$/i.test(name)) convertSource(src, file, engine.encodings?.[file] ?? engine.encoding, buildDir, engine.edits?.[file] ?? [], true);
    }
  }
  const common = [
    '-O2',
    // C++ の例外は JS で扱う方式 (wasm の例外は Safari 15.2 から)
    '-fexceptions',
    ...(engine.defines ?? []).map((d) => `-D${d}`),
    ...(engine.undefines ?? []).map((d) => `-U${d}`),
    ...headerDirs.map((d) => `-I${join(buildDir, 'utf8src', d)}`),
    ...(engine.includes ?? []).map((i) => `-I${join(...locate(i))}`),
    `-I${join(nativeDir, 'shim')}`,
    `-I${tableDir}`,
    // Windows 専用に書かれたもの (engines.mjs の win32Shim) は windows.h の代わりを読む
    ...(engine.win32Shim ? [`-I${join(nativeDir, 'shim', 'win32')}`] : []),
    // 古いライブラリの代わり (native/shim/<名前>)。boost-compat など
    ...(engine.shimIncludes ?? []).map((d) => `-I${join(nativeDir, 'shim', d)}`),
  ];
  // SHIORI のソースは iconv を CP932 対応のものに差し替えて読む (native/shim/engawa_iconv.h)
  const engineFlags = [...common, '-include', 'engawa_iconv.h', ...(engine.prelude ? ['-include', engine.prelude] : [])];
  const objects = [];
  if (engine.rust) objects.push(await buildRust(engine, src, buildDir));
  const jobs = (engine.sources ?? []).map((s) => {
    const file = typeof s === 'string' ? s : s.file;
    const lang = (typeof s === 'string' ? undefined : s.lang) ?? (file.endsWith('.c') ? 'c' : 'c++');
    // ファイルごとに文字コードが違うもの (文 (AYA5) の EUC-JP のファイル) は engines.mjs の encodings で指定する
    const encoding = (typeof s === 'string' ? undefined : s.encoding) ?? engine.encodings?.[file] ?? engine.encoding;
    const obj = join(buildDir, 'obj', file.replace(/^@/, '_').replace(/\.(c|cpp|cc)$/, '.o'));
    objects.push(obj);
    return { file, lang, encoding, obj };
  });
  let done = 0;
  await pool(jobs, Math.max(2, cpus().length), async ({ file, lang, encoding, obj }) => {
    const [root, rel] = locate(file);
    const input = convertSource(root, rel, lang === 'c' ? undefined : encoding, buildDir, file.startsWith('@') ? [] : engine.edits?.[file]);
    mkdirSync(dirname(obj), { recursive: true });
    const flags = lang === 'c' ? [...engineFlags, ...(engine.cflags ?? [])] : [...engineFlags, ...(engine.cxxflags ?? [])];
    // 変換した写しからも、元のファイルの隣のヘッダを "…" で読めるように
    const quote = input === join(root, rel) ? [] : ['-iquote', dirname(join(root, rel))];
    await run(lang === 'c' ? 'emcc' : 'em++', [...flags, ...quote, ...(lang === 'c++' && file.endsWith('.c') ? ['-x', 'c++'] : []), '-c', input, '-o', obj], src);
    done++;
    if (done % 10 === 0 || done === jobs.length) console.log(`[${engine.name}] ${done}/${jobs.length}`);
  });
  mkdirSync(join(buildDir, 'obj'), { recursive: true });
  for (const extra of ['engawa_iconv.c', ...(engine.win32Shim ? ['win32.cpp'] : []), ...(engine.shims ?? [])]) {
    const obj = join(buildDir, 'obj', `shim-${extra.replace(/\W/g, '_')}.o`);
    await run(extra.endsWith('.c') ? 'emcc' : 'em++', [...common, '-c', join(nativeDir, 'shim', extra), '-o', obj], src);
    objects.push(obj);
  }
  const outJs = join(buildDir, `${engine.name}.mjs`);
  const exportsList = ['_load', '_unload', '_request', '_malloc', '_free', ...(engine.exports ?? [])];
  await run(
    'em++',
    [
      '-O2',
      '-fexceptions',
      ...objects,
      ...COMMON_LDFLAGS,
      `-sEXPORT_NAME=create_${engine.name}`,
      `-sEXPORTED_FUNCTIONS=${exportsList.join(',')}`,
      ...(engine.ldflags ?? []),
      '-o',
      outJs,
    ],
    src,
  );
  mkdirSync(outDir, { recursive: true });
  const wasm = readFileSync(outJs.replace(/\.mjs$/, '.wasm'));
  const gz = gzipSync(wasm, { level: 9 });
  writeFileSync(join(outDir, `${engine.name}.wasm.gz`), gz);
  const header = `// ${engine.label}: ${engine.repo} @ ${engine.commit}\n// Emscripten ${version} で native/build.mjs が作ったもの。手で編集しない\n`;
  // wasm はいつも wasmBinary で渡し、locateFile も渡すので、wasm の URL は使わない。
  // Vite が new URL(…, import.meta.url) を素材として探しに行かないよう、ただの文字列にしておく
  const glue = readFileSync(outJs, 'utf-8').replace(/new URL\("([\w.-]+\.wasm)",import\.meta\.url\)\.href/g, '"$1"');
  if (/import\.meta\.url\)/.test(glue.replace(/new URL\("\.",_scriptName\)/g, ''))) console.warn(`[${engine.name}] glue に import.meta.url を使う URL が残っています`);
  writeFileSync(join(outDir, `${engine.name}.mjs`), header + glue);
  writeFileSync(
    join(outDir, `${engine.name}.d.mts`),
    `// native/build.mjs が作ったもの。手で編集しない\nimport type { EngineFactory } from '../../shiori/native-engines';\ndeclare const create: EngineFactory;\nexport default create;\n`,
  );
  writeLicenses(engine, locate, engine.rust ? [section('Rust の標準ライブラリ (The Rust Project Developers、MIT OR Apache-2.0)', readFileSync(join(rustToolchain('nightly'), 'share', 'doc', 'cargo', 'LICENSE-MIT'), 'utf-8').trim()), ...rustLicenses(join(buildDir, 'crate'))] : []);
  console.log(`[${engine.name}] ${relative(root, outDir)}/${engine.name}.wasm.gz  ${(wasm.length / 1e6).toFixed(2)} MB → ${(gz.length / 1e6).toFixed(2)} MB`);
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = wanted.length ? ENGINES.filter((e) => wanted.includes(e.name)) : ENGINES;
if (wanted.length && targets.length !== wanted.length) {
  console.error(`知らない SHIORI: ${wanted.filter((w) => !ENGINES.some((e) => e.name === w)).join(', ')}`);
  process.exit(1);
}
if (process.argv.includes('--clean')) rmSync(join(nativeDir, '.build'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeCommonLicenses();
for (const engine of targets) {
  try {
    await build(engine);
  } catch (e) {
    console.error(`[${engine.name}] 失敗\n${e.message}`);
    process.exitCode = 1;
  }
}
