// 実在のゴーストで Engawa を試す (互換性チェック)。
//   node tools/compat-check.mjs [名前の一部...]   (先に npm run build。Chrome が要る)
// tools/compat-ghosts.txt の GitHub のリポジトリを tools/.compat/ に取ってきて (最新のリリースの .nar。無いか
// 入れられなければ既定のブランチの zip)、dist/index.html をヘッドレス Chrome で開き、1体ずつ
//   インストール → 切り替え → 起動のあいさつ → キャラクターのダブルクリック → 閉じる
// を行って、バルーンの文字・通知・エラーを tools/.compat/report.json と report.md に書く。
// ゴーストのファイルは取ってくるだけで、リポジトリには入れない (それぞれのライセンスがあるため)。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { unzipSync } from 'fflate';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'tools', '.compat');
const page = pathToFileURL(join(root, 'dist', 'index.html')).href;
const chrome =
  process.env.CHROME ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
const PARALLEL = Number(process.env.PARALLEL ?? 4);
/** CDP の1回の呼び出しを待つ長さ (ゴーストがページを固めたら、そのゴーストを error にして次へ) */
const CALL_TIMEOUT = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!chrome) throw new Error('Chrome が見つかりません (環境変数 CHROME で指定できます)');
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html がありません。先に npm run build');
mkdirSync(join(cache, 'nar'), { recursive: true });

// 引数はリポジトリの名前の一部か、手元の .nar / .zip のパス
const wanted = process.argv.slice(2);
const local = wanted.filter((w) => /\.(nar|zip)$/i.test(w) && existsSync(w));
const repos = [
  ...readFileSync(join(root, 'tools', 'compat-ghosts.txt'), 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .filter((r) => !wanted.length || wanted.some((w) => !local.includes(w) && r.toLowerCase().includes(w.toLowerCase()))),
  ...local,
];

// ---------------------------------------------------------------- 取ってくる

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': 'engawa-compat-check' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
}

/** 既定のブランチの zip (無ければ取る) */
async function repoZip(repo) {
  const file = join(cache, 'nar', `${repo.replace('/', '__')}.zip`);
  if (!existsSync(file)) await download(`https://codeload.github.com/${repo}/zip/HEAD`, file);
  return file;
}

/**
 * 最新のリリースの .nar (無ければ undefined)。API は1時間に60回までなので、github.com の
 * releases/latest の転送先と expanded_assets のページから探す
 */
async function releaseNar(repo) {
  const file = join(cache, 'nar', `${repo.replace('/', '__')}.nar`);
  const none = `${file}.none`;
  if (existsSync(file)) return file;
  if (existsSync(none)) return undefined;
  const latest = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'engawa-compat-check' } });
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(latest.headers.get('location') ?? '')?.[1];
  const html = tag ? await (await fetch(`https://github.com/${repo}/releases/expanded_assets/${tag}`, { headers: { 'User-Agent': 'engawa-compat-check' } })).text() : '';
  const href = /href="([^"]+\.nar)"/i.exec(html)?.[1];
  if (!href) {
    writeFileSync(none, '');
    return undefined;
  }
  await download(new URL(href, 'https://github.com/').href, file);
  return file;
}

// ---------------------------------------------------------------- ヘッドレス Chrome

async function openBrowser(profile) {
  rmSync(profile, { recursive: true, force: true });
  const port = 9400 + Math.floor(Math.random() * 2000);
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      // まだ起動していない
    }
  }
  if (!target) {
    proc.kill();
    throw new Error('Chrome が起動しません');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).split('\n')[0]);
    if (msg.method === 'Runtime.consoleAPICalled' && (process.env.VERBOSE || msg.params.type === 'error' || msg.params.type === 'warning')) {
      logs.push(`${msg.params.type} ` + msg.params.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]);
    }
  });
  // Chrome が固まったり落ちたりしたら、待っている呼び出しを失敗させる (待ち続けない)
  let closed = false;
  ws.addEventListener('close', () => {
    closed = true;
    for (const done of pending.values()) done({ error: 'Chrome との接続が切れました' });
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Chrome との接続が切れました'));
      const my = ++id;
      const timer = setTimeout(() => {
        pending.delete(my);
        reject(new Error(`${method} が ${CALL_TIMEOUT / 1000} 秒たっても返りません (ページが固まった?)`));
      }, CALL_TIMEOUT);
      pending.set(my, (res) => {
        clearTimeout(timer);
        if (res?.error && typeof res.error === 'string') reject(new Error(res.error));
        else resolve(res);
      });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return {
    call,
    evaluate,
    logs,
    /** Chrome が終わってから (プロファイルのフォルダを放してから) 消す */
    close: async () => {
      ws.close();
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, sleep(5000)]);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}

const STATE = `({
  status: window.engawa?.status() ?? [],
  balloons: [...document.querySelectorAll('.balloon:not([hidden]) .balloon-text')].map((t) => t.textContent.slice(0, 120)).filter(Boolean),
  toasts: [...document.querySelectorAll('.toast-text')].map((t) => t.textContent),
  errors: window.engawa?.logs('error').slice(-10) ?? [],
  scripts: window.engawa?.logs('script').length ?? 0,
})`;

/** n 番目から後にそのゴーストが再生したスクリプト (ログは「ゴースト名: スクリプト」) */
const scriptsFrom = async (b, n, ghost) =>
  ((await b.evaluate(`window.engawa.logs('script').slice(${n})`)) ?? []).filter((l) => l.startsWith(`${ghost}: `)).map((l) => l.slice(ghost.length + 2, ghost.length + 302));

/** さくらスクリプトからタグを除いた文字 */
const plainText = (script) =>
  script
    .replace(/\\[!&_]*[a-z*]*\[(?:[^\]\\]|\\.)*\]/gi, '')
    .replace(/\\(?:[wspi]\d|_[a-z?]|[0-9a-z*-])/gi, '')
    .trim();

/** 前面のキャラクターの、不透明なピクセルのある所 (クライアント座標) */
const OPAQUE_POINT = `(() => {
  const c = document.querySelector('.character[data-scope="0"]:not([hidden]) canvas');
  if (!c || !c.width) return null;
  const ctx = c.getContext('2d');
  const box = c.getBoundingClientRect();
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  for (const fy of [0.35, 0.5, 0.25, 0.65, 0.15, 0.8]) for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const x = Math.floor(c.width * fx), y = Math.floor(c.height * fy);
    if (data[(y * c.width + x) * 4 + 3] > 128) return { x: box.left + (x + 0.5) * box.width / c.width, y: box.top + (y + 0.5) * box.height / c.height };
  }
  return null;
})()`;

async function dropFile(b, file, name) {
  const b64 = readFileSync(file).toString('base64');
  await b.evaluate(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  })()`);
}

/** バルーンに何か出るまで待つ (最大 ms) */
async function waitTalk(b, ms) {
  for (let t = 0; t < ms; t += 500) {
    const s = await b.evaluate(STATE);
    if (s.balloons.length) return s;
    await sleep(500);
  }
  return b.evaluate(STATE);
}

async function check(repo, slot) {
  const result = { repo, steps: {} };
  let b;
  try {
    let file = local.includes(repo) ? repo : ((await releaseNar(repo).catch(() => undefined)) ?? (await repoZip(repo)));
    b = await openBrowser(join(cache, `profile-${slot}-${Date.now()}`));
    await b.call('Page.navigate', { url: page });
    for (let i = 0; i < 40 && !(await b.evaluate('window.engawa?.ghosts().length')); i++) await sleep(500);
    await sleep(1500);
    const sample = (await b.evaluate('window.engawa.ghosts()'))[0];
    const install = async (f) => {
      const base = repo.split(/[/\\]/).pop().replace(/\.(nar|zip)$/i, '');
      await dropFile(b, f, f.endsWith('.nar') ? `${base}.nar` : `${base}.zip`);
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const s = await b.evaluate(STATE);
        const done = s.toasts.find((t) => /インストールしました|できませんでした/.test(t));
        if (done) return s;
      }
      return b.evaluate(STATE);
    };
    let s = await install(file);
    if (!s.toasts.some((t) => /ゴースト「.*」をインストールしました/.test(t)) && file.endsWith('.nar') && !local.includes(repo)) {
      await b.evaluate(`document.querySelectorAll('.toast .btn-icon').forEach((x) => x.click())`);
      file = await repoZip(repo);
      s = await install(file);
    }
    result.source = file.endsWith('.nar') ? 'release' : 'zip';
    // ソースの zip には git のサブモジュール (yaya-dic など) が入らない
    if (file.endsWith('.zip') && Object.keys(unzipSync(readFileSync(file), { filter: (f) => f.name.endsWith('/.gitmodules') })).length) result.note = 'サブモジュールが zip に入っていない';
    // ソースのリポジトリで、ゴーストが一番上に無い (e_258/ や public/ の中にある) とき
    if (!s.toasts.some((t) => /ゴースト「.*」をインストールしました/.test(t)) && file.endsWith('.zip')) {
      const sub = join(cache, 'nar', `${repo.replace('/', '__')}.sub.zip`);
      const base = spawnSync('python', ['-I', join(root, 'tools', 'compat-subpackage.py'), file, sub], { encoding: 'utf-8' }).stdout?.trim();
      if (base) {
        await b.evaluate(`document.querySelectorAll('.toast .btn-icon').forEach((x) => x.click())`);
        file = sub;
        s = await install(sub);
        result.source = `zip:${base}`;
      }
    }
    result.steps.install = s.toasts;
    if (!s.toasts.some((t) => /ゴースト「.*」をインストールしました/.test(t))) {
      result.verdict = 'not-installed';
      return result;
    }
    // 切り替える
    await b.evaluate(`[...document.querySelectorAll('.toast button')].find((x) => x.textContent === '切り替え')?.click()`);
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const names = await b.evaluate('window.engawa.ghosts()');
      if (names.length && names[0] !== sample) break;
    }
    await sleep(1000);
    s = await waitTalk(b, 15000);
    result.ghost = s.status[0];
    await sleep(2000);
    const name = s.status[0]?.name ?? '';
    result.steps.boot = { ...s, scripts: await scriptsFrom(b, 0, name) };
    if (!s.status.length || name === sample) {
      result.verdict = 'not-booted';
      return result;
    }
    // ダブルクリック
    await sleep(3000);
    await b.evaluate(`document.querySelectorAll('.balloon').forEach((x) => x.click())`);
    await sleep(800);
    const p = await b.evaluate(OPAQUE_POINT);
    let n = (await b.evaluate(STATE)).scripts;
    if (p) {
      for (const clickCount of [1, 2]) {
        await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount });
        await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount });
      }
      result.steps.doubleClick = await waitTalk(b, 6000);
      await sleep(1000);
      result.steps.doubleClick.scripts = await scriptsFrom(b, n, name);
    } else result.steps.doubleClick = { note: 'キャラクターが見えない' };
    // 閉じる (終わるまでは待たない)
    n = (await b.evaluate(STATE)).scripts;
    await b.evaluate('(window.engawa.close(), 0)');
    await sleep(4000);
    result.steps.close = { scripts: await scriptsFrom(b, n, name), errors: (await b.evaluate(STATE)).errors };
    const unsupported = result.steps.boot.balloons.some((t) => t.startsWith('[Engawa]'));
    const scripts = Object.values(result.steps).flatMap((step) => step.scripts ?? []);
    // SHIORI のエラー (null function・Lua の stack traceback など)。SAORI が使えないのは別に数える
    // (SHIORI の標準出力もエラーログに入るので、エラーらしい行だけ)
    const looksError = (t) => /stack traceback|error|failed|null function|unreachable|エラー|失敗/i.test(t);
    result.shioriErrors = [...new Set([...result.steps.close.errors, ...scripts].filter(looksError))].filter((t) => !/SAORI: .* はブラウザでは使えません|SAORI error\(load\)/.test(t));
    result.verdict = unsupported
      ? 'shiori-unsupported'
      : !result.steps.boot.scripts.length
        ? 'silent-boot'
        : result.shioriErrors.length
          ? 'errors'
          : !result.steps.boot.scripts.some((t) => plainText(t))
            ? 'quiet'
            : 'ok';
    return result;
  } catch (e) {
    result.verdict = 'error';
    result.error = e.message;
    return result;
  } finally {
    if (b) {
      result.console = b.logs.slice(0, process.env.VERBOSE ? 400 : 20);
      await b.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- 実行

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, repos.length) }, async (_, slot) => {
    while (next < repos.length) {
      const repo = repos[next++];
      process.stderr.write(`[${next}/${repos.length}] ${repo}\n`);
      const r = await check(repo, slot);
      results.push(r);
      console.log(`${r.verdict.padEnd(18)} ${repo}  ${r.ghost ? `${r.ghost.name} / ${r.ghost.shiori}` : (r.error ?? r.steps.install?.join(' ') ?? '')}`);
    }
  }),
);
// 一部だけ試したときは、前の結果のうち試していないものを残す
const reportFile = join(cache, 'report.json');
if (wanted.length && existsSync(reportFile)) {
  for (const old of JSON.parse(readFileSync(reportFile, 'utf-8'))) if (!results.some((r) => r.repo === old.repo)) results.push(old);
}
results.sort((a, b) => a.repo.localeCompare(b.repo));
writeFileSync(join(cache, 'report.json'), JSON.stringify(results, null, 2));
const rows = results.map((r) => {
  const talk = (step) => (r.steps[step]?.scripts ?? []).map(plainText).filter(Boolean).join(' / ').replace(/\|/g, '｜').slice(0, 60);
  return `| ${r.repo} | ${r.verdict}${r.note ? ` (${r.note})` : ''} | ${r.ghost?.shiori ?? ''} | ${talk('boot')} | ${talk('doubleClick')} | ${talk('close')} | ${(r.console ?? []).length + (r.steps.boot?.errors?.length ?? 0)} |`;
});
const count = (v) => results.filter((r) => r.verdict === v).length;
writeFileSync(
  join(cache, 'report.md'),
  [`# 互換性チェック (${new Date().toISOString().slice(0, 10)})`, '', `ok ${count('ok')} / ${results.length}`, '', '| リポジトリ | 結果 | SHIORI | 起動 | ダブルクリック | 終了 | エラー |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n'),
);
console.log(`\nok ${count('ok')} / ${results.length}  → ${join(cache, 'report.md')}`);
