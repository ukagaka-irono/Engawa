import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Descript } from '../src/package/descript';
import { buildRequest, parseResponse } from '../src/shiori/protocol';
import { pngHasAlpha, parseAlphaMode } from '../src/util/image';
import { decodeText } from '../src/util/text';
import { filesFromZip } from '../src/vfs/archive';
import { normalizePath } from '../src/vfs/files';

describe('SHIORI/3.0', () => {
  it('builds a request with references and line breaks replaced', () => {
    const req = buildRequest({ method: 'GET', id: 'OnTest', references: ['a\r\nb', undefined, 3] });
    expect(req).toContain('GET SHIORI/3.0\r\n');
    expect(req).toContain('ID: OnTest\r\n');
    expect(req).toContain('Reference0: a\x01b\r\n');
    expect(req).not.toContain('Reference1');
    expect(req).toContain('Reference2: 3\r\n');
    expect(req.endsWith('\r\n\r\n')).toBe(true);
  });

  it('parses a 200 response value', () => {
    const res = parseResponse('SHIORI/3.0 200 OK\r\nCharset: UTF-8\r\nValue: \\0hello\\e\r\n\r\n');
    expect(res.status).toBe(200);
    expect(res.value).toBe('\\0hello\\e');
  });

  it('has no value for 204', () => {
    expect(parseResponse('SHIORI/3.0 204 No Content\r\n\r\n').value).toBeUndefined();
  });
});

describe('text files', () => {
  const sjisName = new Uint8Array([0x96, 0xbc, 0x91, 0x4f]); // "名前" in Shift_JIS

  it('decodes Shift_JIS when the file is not valid UTF-8', () => {
    expect(decodeText(sjisName)).toBe('名前');
  });

  it('follows the charset line', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('charset,Shift_JIS\r\nname,'), 0x96, 0xbc]);
    expect(Descript.parse(decodeText(bytes)).str('name')).toBe('名');
  });

  it('ignores a caller hint that does not fit the bytes', () => {
    // UTF-8 と指定されても、UTF-8 として不正なら推測に戻る
    expect(decodeText(sjisName, 'UTF-8')).toBe('名前');
  });

  it('keeps everything after the first comma as the value', () => {
    const d = Descript.parse('// comment\r\nSakura.BindGroup0.Name,帽子,麦わら\r\n');
    expect(d.str('sakura.bindgroup0.name')).toBe('帽子,麦わら');
  });
});

describe('paths and archives', () => {
  it('normalizes separators, case and Unicode form', () => {
    expect(normalizePath('Shell\\Master\\..\\master\\ﾊﾟ.png')).toBe('shell/master/ﾊﾟ.png');
    expect(normalizePath('パンツ.PNG')).toBe('パンツ.png');
  });

  it('reads UTF-8 names from a zip', () => {
    const zip = zipSync({ 'shell/master/からだ.png': new Uint8Array([1, 2, 3]), 'install.txt': new Uint8Array([65]) });
    const tree = filesFromZip(zip);
    expect(tree.get('shell/master/からだ.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(tree.has('install.txt')).toBe(true);
  });

  it('skips folder entries named with backslashes', () => {
    // Windows の道具で作った nar にある (フォルダを空のファイルとして置くと、中のファイルを置けなくなる)
    const zip = zipSync({ 'ghost\\master\\ex\\': new Uint8Array(), 'ghost\\master\\ex\\a.txt': new Uint8Array([1]) });
    const tree = filesFromZip(zip);
    expect([...tree.entries()].map(([p]) => p)).toEqual(['ghost/master/ex/a.txt']);
    // 2バイト目が \ の Shift_JIS (ソ = 83 5C) で終わる名前はファイル
    const sjis = zipSync({ QZ: new Uint8Array([2]) });
    for (let i = 0; i + 1 < sjis.length; i++) if (sjis[i] === 0x51 && sjis[i + 1] === 0x5a) sjis.set([0x83, 0x5c], i);
    expect([...filesFromZip(sjis).entries()].map(([p]) => p)).toEqual(['ソ']);
  });
});

describe('images', () => {
  const png = (colorType: number, chunks: string[] = []) => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...[...'IHDR'].map((c) => c.charCodeAt(0))];
    bytes.push(0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0, 0, 0, 0, 0);
    for (const type of chunks) bytes.push(0, 0, 0, 0, ...[...type].map((c) => c.charCodeAt(0)), 0, 0, 0, 0);
    return new Uint8Array(bytes);
  };

  it('detects alpha from the PNG header', () => {
    expect(pngHasAlpha(png(6))).toBe(true);
    expect(pngHasAlpha(png(2))).toBe(false);
    expect(pngHasAlpha(png(2, ['tRNS', 'IDAT']))).toBe(true);
    expect(pngHasAlpha(png(2, ['IDAT', 'tRNS']))).toBe(false);
  });

  it('parses use_self_alpha values', () => {
    expect(parseAlphaMode('1')).toBe('on');
    expect(parseAlphaMode('true')).toBe('on');
    expect(parseAlphaMode('full')).toBe('full');
    expect(parseAlphaMode(undefined)).toBe('off');
  });
});
