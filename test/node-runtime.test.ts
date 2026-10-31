import { describe, expect, it } from 'vitest';
import { startNode } from '../src/shiori/node-runtime';

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * SHIOLINK の Node.js のプログラムを動かす小さな Node.js (src/shiori/node-runtime.ts)。
 * shiolinkjs と同じ形 (標準入力の「*S:ID」を返してから応答を書く) の、ここで書いたプログラムで確かめる
 */
describe('SHIOLINK の Node.js のプログラム', () => {
  const files = new Map<string, Uint8Array>([
    // package.json の exports は、Node と同じく書かれた順に require・node・default を選ぶ (import は選ばない)
    ['node_modules/link/package.json', utf8(JSON.stringify({ name: 'link', exports: { '.': { import: './esm.mjs', require: './cjs/index.js' }, './extra': './extra.js' } }))],
    ['node_modules/link/cjs/index.js', utf8("const { greet } = require('../extra');\nmodule.exports = { greet, sep: require('path').sep };\n")],
    ['node_modules/link/extra.js', utf8("exports.greet = (n) => 'こんにちは、' + n;\n")],
    ['data.json', utf8('{"name": "テスト"}')],
    [
      'lib/main.js',
      utf8(
        [
          "const link = require('link');",
          "const data = require('../data.json');",
          "const WS = require('ws');",
          'let echo = "";',
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', async (chunk) => {",
          '  const m = /^\\*S:(.*)\\r\\n([\\s\\S]*)$/.exec(chunk);',
          '  if (!m) return;',
          "  const sstp = await (await fetch('http://localhost:9801/api/sstp/v1', { method: 'POST', body: 'NOTIFY SSTP/1.1\\nSender: test\\n\\n' })).text();",
          "  process.stdout.write('*S:' + m[1] + '\\r\\n');",
          "  process.stdout.write('PLUGIN/2.0 200 OK\\r\\nValue: ' + link.greet(data.name) + link.sep + (typeof WS) + ' ' + sstp.split('\\r\\n')[0] + '\\r\\n\\r\\n');",
          '});',
        ].join('\n'),
      ),
    ],
  ]);

  it('require (node_modules・exports・JSON・ws) と標準入出力、ベースウェアへの SSTP over HTTP', async () => {
    let out = '';
    const sent: string[] = [];
    const node = startNode(
      {
        files,
        stdout: (t) => (out += t),
        stderr: () => {},
        write: () => {},
        sstp: async (req) => {
          sent.push(req);
          return 'SSTP/1.4 204 No Content\r\n\r\n';
        },
      },
      ['./lib/main.js'],
    );
    node.stdin('*S:1\r\nGET PLUGIN/2.0\r\nID: version\r\n\r\n');
    for (let i = 0; i < 50 && !out.endsWith('\r\n\r\n'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(out).toBe('*S:1\r\nPLUGIN/2.0 200 OK\r\nValue: こんにちは、テスト/function SSTP/1.4 204 No Content\r\n\r\n');
    // SSTP の改行は CR LF にして送る
    expect(sent).toEqual(['NOTIFY SSTP/1.1\r\nSender: test\r\n\r\n']);
  });

  it('node main.js の main.js はファイルのパス。package.json の main が自分を指していても止まらず、失敗したモジュールはキャッシュしない', () => {
    const f = new Map([
      ['node_modules/loop/package.json', utf8(JSON.stringify({ name: 'loop', main: '.' }))],
      ['node_modules/loop/index.js', utf8('module.exports = "loop";')],
      ['bad.js', utf8('globalThis.__badCount = (globalThis.__badCount ?? 0) + 1; throw new Error("bad");')],
      [
        'main.js',
        utf8(
          [
            'let first = "", second = "";',
            "try { require('./bad'); } catch (e) { first = e.message; }",
            "try { require('./bad'); } catch (e) { second = e.message; }",
            "process.stdout.write([require('loop'), first, second, globalThis.__badCount].join(','));",
          ].join('\n'),
        ),
      ],
    ]);
    let out = '';
    startNode({ files: f, stdout: (t) => (out += t), stderr: () => {}, write: () => {}, sstp: async () => '' }, ['main.js']);
    expect(out).toBe('loop,bad,bad,2');
    delete (globalThis as { __badCount?: number }).__badCount;
  });

  it('見つからないモジュールは Node と同じく MODULE_NOT_FOUND で投げる', () => {
    const f = new Map([['main.js', utf8("try { require('nothing'); } catch (e) { module.exports = e.code; }\nprocess.stdout.write(module.exports);")]]);
    let out = '';
    startNode({ files: f, stdout: (t) => (out += t), stderr: () => {}, write: () => {}, sstp: async () => '' }, ['./main.js']);
    expect(out).toBe('MODULE_NOT_FOUND');
  });
});
