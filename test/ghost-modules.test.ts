import { describe, expect, it } from 'vitest';
import { httpEvent, httpFileName, parseHttp } from '../src/ghost/http';
import { anchorPoint, moveTarget, parseMove } from '../src/ghost/move';
import { readProperty, writeProperty, type PropertyHost } from '../src/ghost/properties';
import { seekTime } from '../src/ghost/sound-options';
import { randomWord } from '../src/ghost/words';
import { parseUpdateList, updateBase } from '../src/package/update';
import { parseBlend } from '../src/shell/blend';
import { md5 } from '../src/util/md5';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('MD5', () => {
  it('よく知られた値と一致する', () => {
    expect(md5(bytes(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5(bytes('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5(bytes('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    // 64 バイトの境目をまたぐ長さ
    expect(md5(bytes('a'.repeat(100)))).toBe('36a92cc94a9e0fa21f625f8bfb007adf');
  });
});

describe('ネットワーク更新の一覧', () => {
  it('updates2.dau (ファイル名\\1MD5\\1…) と updates.txt (file,…) を読み、危ないパスは除く', () => {
    const dau = parseUpdateList(bytes('ghost/master/a.dic\x01d41d8cd98f00b204e9800998ecf8427e\x01size=0\x01\r\n../evil.txt\x01d41d8cd98f00b204e9800998ecf8427e\x01\r\nbad\x01xyz\x01\r\n'));
    expect(dau).toEqual([{ path: 'ghost/master/a.dic', md5: 'd41d8cd98f00b204e9800998ecf8427e' }]);
    const txt = parseUpdateList(bytes('charset,UTF-8\r\nfile,shell\\master\\surface0.png\x0136A92CC94A9E0FA21F625F8BFB007ADF\x01\r\n'));
    expect(txt).toEqual([{ path: 'shell/master/surface0.png', md5: '36a92cc94a9e0fa21f625f8bfb007adf' }]);
  });

  it('%xx を戻してから危ないパスを除く (シェルの更新からゴースト本体を書き換えられないように)', () => {
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const list = parseUpdateList(bytes([`%2e%2e/%2e%2e/ghost/master/shiori.js\x01${md5}\x01`, `%2E%2E%5Cx.dic\x01${md5}\x01`, `%2Fabs.txt\x01${md5}\x01`, `c%3A/x.txt\x01${md5}\x01`, `a%20b.png\x01${md5}\x01`].join('\r\n')));
    expect(list.map((e) => e.path)).toEqual(['a b.png']);
  });

  it('取得先は http(s) の homeurl に / を足したもの', () => {
    expect(updateBase('https://example.com/ghost')).toBe('https://example.com/ghost/');
    expect(updateBase('ftp://example.com/')).toBeUndefined();
  });
});

describe('\\![execute,http-…]', () => {
  it('オプションを読む', () => {
    const r = parseHttp('http-post', ['https://example.com/api', '--async=OnDone', '--nofile=UTF-8', '--param=a=1', '--header=X-Test: yes', '--timeout=10'])!;
    expect(r).toMatchObject({ method: 'post', rss: false, url: 'https://example.com/api', id: 'OnDone', sync: false, nofile: 'UTF-8', params: ['a=1'], headers: [['X-Test', 'yes']], timeout: 10 });
    expect(httpEvent(r, true)).toBe('OnDone');
    expect(httpEvent(r, false)).toBe('OnDoneFailure');
    expect(httpEvent(parseHttp('rss-get', ['https://example.com/feed'])!, true)).toBe('OnExecuteRSSComplete');
    expect(parseHttp('http-fly', ['x'])).toBeUndefined();
  });

  it('--file の名前は var/ の中だけ (.. や download/ へは出られない。壊れた %xx でも止まらない)', () => {
    expect(httpFileName('log.json')).toBe('log.json');
    expect(httpFileName('cache/a.txt')).toBe('cache/a.txt');
    expect(httpFileName('../download/setup.exe')).toBe('download/setup.exe');
    expect(httpFileName('..%2F..%2Fshell%2Fmaster%2Fsurface0.png')).toBe('shell/master/surface0.png');
    expect(httpFileName('100%')).toBe('100%');
    expect(httpFileName('a:b?.txt')).toBe('a_b_.txt');
    expect(httpFileName('')).toBe('index.html');
  });
});

describe('\\![move]', () => {
  it('新旧の書き方を読む', () => {
    expect(parseMove(['--X=10', '--Y=fix', '--time=500', '--base=0', '--base-offset=right.top', '--move-offset=left.top'])).toMatchObject({ x: 10, y: undefined, time: 500, base: '0', baseOffset: 'right.top' });
    expect(parseMove(['40', '100', '0', '0', 'left.top', 'left.top'])).toMatchObject({ x: 40, y: 100, base: '0' });
  });

  it('基準の矩形の位置に、動かす矩形の位置を合わせる', () => {
    const base = { left: 100, top: 200, width: 50, height: 80 };
    expect(anchorPoint(base, 'right.bottom')).toEqual({ x: 150, y: 280 });
    const me = { left: 0, top: 0, width: 20, height: 30 };
    // 相方の左上を本体側の右上に合わせて、右へ 10
    expect(moveTarget(parseMove(['--X=10', '--Y=0', '--base-offset=right.top', '--move-offset=left.top']), me, base)).toEqual({ left: 160, top: 200 });
    // 省略した座標は今のまま
    expect(moveTarget(parseMove(['--X=0']), { ...me, top: 77 }, base)).toEqual({ left: 100, top: 77 });
  });
});

describe('合成メソッド', () => {
  it('-fast と古い名前を読む', () => {
    expect(parseBlend('overlaymultiply')).toEqual({ mode: 'multiply', fast: true });
    expect(parseBlend('overlay')).toBeUndefined();
  });
});

describe('%ms などの言葉', () => {
  it('知っている名前だけ返す', () => {
    expect(randomWord('ms')).toBeTruthy();
    expect(randomWord('nonexistent')).toBeUndefined();
  });
});

describe('プロパティシステム', () => {
  const saved: Record<string, string> = {};
  const set: string[] = [];
  const shell = {
    name: 'マスター',
    dir: 'master',
    files: { list: () => ['surface0.png', 'surface10.png', 'surface3.png'] },
    descript: { str: () => '' },
    surfaces: { surfaces: new Map([[3, {}], [10, {}]]), cursors: new Map(), tooltips: new Map() },
  };
  const h = {
    name: 'テスト',
    sakuraName: 'さくら',
    keroName: 'うにゅう',
    path: 'ghost/test',
    descript: { str: (k: string) => (k === 'craftmanw' ? '作者' : '') },
    shell,
    shellDirs: ['master'],
    shellOf: () => shell,
    balloonName: '内蔵バルーン',
    balloonPath: '',
    status: 'talking,balloon(0=0)',
    userName: 'ユーザ',
    desktop: { width: 800, height: 600 },
    idleSeconds: 3,
    installed: [],
    active: [],
    scopes: [0],
    scope: (id: number) =>
      id === 0 ? { surface: 5, animations: [1, 2], defaultSurface: 0, rect: { left: 10, top: 20, width: 100, height: 200 }, base: { x: 60, y: 220 }, scaling: 1, name: '' } : undefined,
    balloon: () => undefined,
    sounds: [],
    sticky: '0,1',
    zorder: '',
    saved,
    logs: () => [],
    setSurface: (scope: number, id: string) => set.push(`${scope}:${id}`),
    playAnimation: () => {},
    setDefaultSurface: () => {},
    setSticky: () => {},
    setZorder: () => {},
    setSound: () => false,
    save: () => {},
  } as unknown as PropertyHost;

  it('ゴースト・スコープ・シェルの値を読む', () => {
    expect(readProperty('currentghost.craftmanw', h)).toBe('作者');
    expect(readProperty('currentghost.status', h)).toBe('talking,balloon(0=0)');
    expect(readProperty('currentghost.scope(0).surface.num', h)).toBe('5');
    // 華和梨は ( ) の中の括弧を消すので、scope0 のような書き方でも読めるように
    expect(readProperty('currentghost.scope0.surface.num', h)).toBe('5');
    expect(readProperty('currentghost.scope(0).animation.num', h)).toBe('1,2');
    expect(readProperty('currentghost.scope(0).rect', h)).toBe('10,20,110,220');
    expect(readProperty('currentghost.scope(0).x', h)).toBe('60');
    expect(readProperty('currentghost.scope(1).name', h)).toBe('うにゅう');
    expect(readProperty('currentghost.shelllist.current.name', h)).toBe('マスター');
    expect(readProperty('currentghost.shelllist.count', h)).toBe('1');
    expect(readProperty('currentghost.seriko.surfacelist.all', h)).toBe('0,3,10');
    expect(readProperty('currentghost.seriko.surfacelist.defined', h)).toBe('3,10');
    expect(readProperty('currentghost.seriko.sticky-window', h)).toBe('0,1');
    expect(readProperty('system.os.type', h)).toBe('Web');
    expect(readProperty('no.such.property', h)).toBe('');
  });

  it('[SET有効] のものを書く', () => {
    expect(writeProperty('currentghost.scope(0).surface.num', '7', h)).toBe(true);
    expect(set).toEqual(['0:7']);
    expect(writeProperty('currentghost.seriko.tooltip.scope(0).textlist(Head).text', '頭', h)).toBe(true);
    expect(readProperty('currentghost.seriko.tooltip.scope(0).textlist(head).text', h)).toBe('頭');
    expect(readProperty('currentghost.seriko.tooltip.scope(0).textlist.count', h)).toBe('1');
    expect(writeProperty('currentghost.mousecursor', 'hand.cur', h)).toBe(true);
    expect(readProperty('currentghost.mousecursor', h)).toBe('hand.cur');
    expect(writeProperty('currentghost.shelllist(マスター).menu', 'hidden', h)).toBe(true);
    expect(readProperty('currentghost.shelllist.index(0).menu', h)).toBe('hidden');
    expect(writeProperty('baseware.name', 'x', h)).toBe(false);
  });
});

describe('\\![sound] の --seektime', () => {
  it('「:」が無ければミリ秒、あれば [[時:]分:]秒[.ミリ秒]', () => {
    expect(seekTime('9050')).toBe(9050);
    expect(seekTime('1:30.5')).toBe(90500);
    expect(seekTime('1:00:00')).toBe(3600000);
    expect(seekTime('x')).toBeUndefined();
    expect(seekTime(undefined)).toBeUndefined();
  });
});
