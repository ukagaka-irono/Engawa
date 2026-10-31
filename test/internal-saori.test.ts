import { describe, expect, it } from 'vitest';
import createKawari from '../src/assets/shiori/kawari.mjs';
import KAWARI_WASM from '../src/assets/shiori/kawari.wasm.gz?inline';
import type { SaoriEffect } from '../src/saori/context';
import { internalSaori } from '../src/saori/internal';
import { mediaInfo } from '../src/saori/media-info';
import type { EmscriptenFS } from '../src/shiori/native-engines';
import { encodeCharset } from '../src/util/charset-encode';
import { boot } from './native-boot';

const utf8 = (s: string) => new TextEncoder().encode(s);
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 8000Hz・8bit・モノラルで 0.5 秒の WAV。LIST INFO の INAM (Shift_JIS) に title */
function wav(title: string): Uint8Array {
  const name = [...encodeCharset(title, 'Shift_JIS'), 0];
  if (name.length & 1) name.push(0);
  const info = [...chars('INFO'), ...chars('INAM'), ...le32(name.length), ...name];
  const fmt = [...chars('fmt '), ...le32(16), ...le16(1), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8)];
  const list = [...chars('LIST'), ...le32(info.length), ...info];
  const data = [...chars('data'), ...le32(4000), ...new Array(4000).fill(128)];
  const body = [...chars('WAVE'), ...fmt, ...list, ...data];
  return Uint8Array.from([...chars('RIFF'), ...le32(body.length), ...body]);
}

/** ID3v2.3 (TIT2 は UTF-16、TPE1 は ISO-8859-1、TRCK は 3/12) と、Xing ヘッダ (100 フレーム) の MPEG1 Layer3 */
function mp3(): Uint8Array {
  const frame = (id: string, body: number[]) => [...chars(id), ...[0, 0, 0, body.length].map((v, i) => (i === 3 ? body.length : v)), 0, 0, ...body];
  const utf16 = (s: string) => [0xff, 0xfe, ...[...s].flatMap((c) => le16(c.charCodeAt(0)))];
  const tags = [...frame('TIT2', [1, ...utf16('曲名')]), ...frame('TPE1', [0, ...chars('Artist')]), ...frame('TRCK', [0, ...chars('3/12')])];
  const size = tags.length;
  const id3 = [...chars('ID3'), 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...tags];
  // 128kbps・44.1kHz・ステレオ。サイド情報 32 バイトの後ろに Xing (フレーム数あり)
  const header = [0xff, 0xfb, 0x90, 0x00, ...new Array(32).fill(0), ...chars('Xing'), 0, 0, 0, 1, 0, 0, 0, 100];
  return Uint8Array.from([...id3, ...header, ...new Array(400).fill(0)]);
}

describe('MediaInfo (音声のタグと長さ)', () => {
  it('WAV: 長さと LIST INFO のタイトル。知らないキー・映像の大きさは空', () => {
    expect(mediaInfo(wav('タイトル'), ['title', 'duration', 'width', 'nosuchkey'])).toEqual({ result: 'audio', values: ['タイトル', '500', '', ''] });
  });

  it('MP3: ID3v2 (UTF-16・ISO-8859-1)、曲番号は番号だけ、長さは Xing のフレーム数から', () => {
    expect(mediaInfo(mp3(), ['title', 'artist', 'track', 'duration'])).toEqual({ result: 'audio', values: ['曲名', 'Artist', '3', '2612'] });
  });

  it('読めない形式は Result も値も空', () => {
    expect(mediaInfo(utf8('hello'), ['title', 'duration'])).toEqual({ result: '', values: ['', ''] });
  });
});

describe('SAORI over DirectSSTP (internal_file)', () => {
  const files = new Map<string, Uint8Array>([['/ghost/master/sound/a.wav', wav('テスト')]]);
  const fs = {
    analyzePath: (p: string) => ({ exists: files.has(p) }),
    stat: () => ({ mode: 0o100644, size: 0, mtime: 0 }),
    isFile: () => true,
    readFile: (p: string) => files.get(p)!,
  } as unknown as EmscriptenFS;
  const effects: SaoriEffect[] = [];
  const ctx = { fs, root: '/ghost/master', post: (e: SaoriEffect) => effects.push(e) };
  const call = (...lines: string[]) => new TextDecoder().decode(internalSaori(utf8(`${lines.join('\r\n')}\r\n\r\n`), ctx));

  it('同期の MediaInfo は Result と Value0… (相対パスは ghost/master から、\\ も区切り)', () => {
    const res = call('EXECUTE SAORI/1.0', 'Module: internal_file', 'Charset: UTF-8', 'Argument0: MediaInfo', 'Argument1: sound\\a.wav', 'Argument2: title', 'Argument3: duration');
    expect(res).toMatch(/^SAORI\/1\.0 200 OK\r\n/);
    expect(res).toContain('Result: audio\r\nValue0: テスト\r\nValue1: 500\r\n');
  });

  it('GET Version・知らないモジュールや関数・無いファイル', () => {
    expect(call('GET Version SAORI/1.0', 'Module: internal_file', 'Charset: UTF-8')).toContain('200 OK');
    expect(call('EXECUTE SAORI/1.0', 'Module: internal_nothing', 'Charset: UTF-8', 'Argument0: X')).toContain('ErrorDescription: unknown module');
    expect(call('EXECUTE SAORI/1.0', 'Module: internal_file', 'Charset: UTF-8', 'Argument0: X')).toContain('ErrorDescription: unknown function');
    expect(call('EXECUTE SAORI/1.0', 'Module: internal_file', 'Charset: UTF-8', 'Argument0: MediaInfo', 'Argument1: none.mp3', 'Argument2: title')).toContain('ErrorDescription: file not found');
    // SSTP の要求は答えない (華和梨には送れなかったことになる)
    expect(internalSaori(utf8('EXECUTE SSTP/1.1\r\nCommand: GetName\r\n\r\n'), ctx)).toBeUndefined();
  });

  it('--async=On… は 204 を返し、結果をそのイベントで届ける (Reference0 = 識別子、1 = Result、2・3 = モジュール・関数、4… = 値)', async () => {
    effects.length = 0;
    const res = call('EXECUTE SAORI/1.0', 'Module: internal_file', 'Charset: UTF-8', 'Argument0: MediaInfo', 'Argument1: sound/a.wav', 'Argument2: title', 'Argument3: duration', 'Argument4: --async=OnSoundInfo3');
    expect(res).toMatch(/^SAORI\/1\.0 204/);
    await new Promise((r) => setTimeout(r, 0));
    expect(effects).toEqual([{ kind: 'event', id: 'OnSoundInfo3', refs: ['OnSoundInfo3', 'audio', 'internal_file', 'MediaInfo', 'テスト', '500'] }]);
  });
});

describe('華和梨 9 から呼ぶ (callsaori "internal_file" …)', () => {
  it('本体の窓 (NOTIFY hwnd) が分かれば、Direct SSTP で Engawa の内蔵モジュールを呼べる', async () => {
    const sjis = (text: string) => encodeCharset(text.replace(/\n/g, '\r\n'), 'Shift_JIS');
    const k = await boot(createKawari, KAWARI_WASM, {
      'kawarirc.kis': sjis(['System.Callback.OnGET : $(entry ${System.Request.ID})', 'OnSync : $(callsaori "internal_file" "MediaInfo" "a.wav" "title" "duration")', 'OnAsync : $(callsaori "internal_file" "MediaInfo" "a.wav" "title" "--async=OnInfo1")done', ''].join('\n')),
      'a.wav': wav('曲'),
    });
    expect(k.loaded).toBe(1);
    k.raw(encodeCharset('NOTIFY SHIORI/3.0\r\nCharset: Shift_JIS\r\nSender: Engawa\r\nID: hwnd\r\nReference0: 1\x012\r\nReference1: 101\x01102\r\n\r\n', 'Shift_JIS'));
    expect(k.get('OnSync')).toContain('Value: audio\r\n');
    expect(k.get('OnAsync')).toContain('Value: done\r\n');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.effects).toContainEqual({ kind: 'event', id: 'OnInfo1', refs: ['OnInfo1', 'audio', 'internal_file', 'MediaInfo', '曲'] });
    k.m._unload();
  });
});
