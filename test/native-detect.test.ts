import { describe, expect, it } from 'vitest';
import { detectNativeEngine } from '../src/shiori/native-detect';
import { FileTree } from '../src/vfs/files';

/** Windows の DLL の代わり。中に文字列が入っているだけのバイト列 */
const dll = (...strings: string[]) => new TextEncoder().encode(`MZ\0\0${strings.join('\0')}\0`);
/** UTF-16LE の文字列 */
const wide = (text: string) => new Uint8Array([...text].flatMap((c) => [c.charCodeAt(0), 0]));
/** VS_FIXEDFILEINFO の頭 (印・構造の版・ファイルバージョン)。4 バイト境界に置くため前を埋める */
const fixedInfo = (a: number, b: number, c: number, d: number) => {
  const v = new DataView(new ArrayBuffer(20));
  v.setUint32(4, 0xfeef04bd, true);
  v.setUint32(8, 0x10000, true);
  v.setUint32(12, (a << 16) | b, true);
  v.setUint32(16, (c << 16) | d, true);
  return new Uint8Array(v.buffer);
};
/** 4 バイト境界にそろえてつなぐ */
const join = (...parts: Uint8Array[]) => {
  const out: number[] = [];
  for (const p of parts) {
    while (out.length % 4) out.push(0);
    out.push(...p);
  }
  return new Uint8Array(out);
};
const ghost = (files: Record<string, Uint8Array | string>) =>
  new FileTree(Object.entries(files).map(([p, d]) => [`ghost/master/${p}`, typeof d === 'string' ? new TextEncoder().encode(d) : d]));

describe('detectNativeEngine', () => {
  it('同梱の DLL の中身で見分ける (名前を変えてあっても)', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('yaya.dll', 'aya5.dll') }))?.id).toBe('yaya');
    expect(detectNativeEngine('aya5.dll', ghost({ 'aya5.dll': dll('aya5.dll') }))?.id).toBe('aya5');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('kawarirc.kis', 'kawari.ini') }))?.id).toBe('kawari');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('kawari.ini') }))?.id).toBe('kawari7');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('Sender: nashi') }))?.id).toBe('nashi');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('talks/main.mnt') }))?.id).toBe('minato');
    expect(detectNativeEngine('kagari.dll', ghost({ 'kagari.dll': dll('index.lua') }))?.id).toBe('kagari');
    expect(detectNativeEngine('emo.dll', ghost({ 'emo.dll': dll('[emo::unload] ') }))?.id).toBe('emo');
    expect(detectNativeEngine('quickshiori.dll', ghost({ 'quickshiori.dll': dll('__shiori_request') }))?.id).toBe('quickshiori');
  });

  it('里々は DLL の版で 1.x と 2.x を選ぶ (2.x の DLL は文字列を UTF-16 で持つ)', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': join(dll(), wide('satori_conf.txt'), fixedInfo(2, 206, 2, 1)) }))?.id).toBe('satori');
    expect(detectNativeEngine('satori.dll', ghost({ 'satori.dll': join(dll('phase Mc172-2', 'satori_conf.txt'), fixedInfo(1, 172, 2, 1)) }))?.id).toBe('satori1');
    // 版の情報が無ければ、文字列が ASCII なら 1.x
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('satori_conf.txt') }))?.id).toBe('satori1');
    // DLL が無ければ最新の版
    expect(detectNativeEngine('satori.dll', ghost({ 'satori_conf.txt': '' }))?.id).toBe('satori');
  });

  it('minato は DLL の版で 0.3 より前を選ぶ', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('talks/main.mnt', 'versioncraftmanmizuki0.3.0not initialized') }))?.id).toBe('minato');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('talks/main.mnt', 'versioncraftmanmizuki0.2.2not initialized') }))?.id).toBe('minato02');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('talks/main.mnt', 'versioncraftmanmizuki0.1.6not initialized') }))?.id).toBe('minato02');
  });

  it('DLL が無ければ名前で、名前でも分からなければ設定ファイルで', () => {
    expect(detectNativeEngine('satori.dll', ghost({}))?.id).toBe('satori');
    expect(detectNativeEngine('YAYA.DLL', ghost({}))?.id).toBe('yaya');
    expect(detectNativeEngine('shiori.dll', ghost({ 'kawarirc.kis': '' }))?.id).toBe('kawari');
    expect(detectNativeEngine('shiori.dll', ghost({ 'talks/main.mnt': '' }))?.id).toBe('minato');
    expect(detectNativeEngine('shiori.dll', ghost({ 'emo/shiori/init.lua': '' }))?.id).toBe('emo');
  });

  it('WebAssembly にしていない SHIORI の DLL なら、設定ファイルで当て推量しない (灯のプラグインが YAYA as SAORI を持つとき)', () => {
    expect(detectNativeEngine('akari.dll', ghost({ 'akari.dll': dll('main.azr'), 'yaya.txt': '' }))).toBeUndefined();
    expect(detectNativeEngine('SHIOLINK.dll', ghost({ 'yaya.txt': '' }))).toBeUndefined();
  });

  it('どれにも当たらなければ undefined', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('something else') }))).toBeUndefined();
    expect(detectNativeEngine('dnproxy.dll', ghost({ 'user.dll': dll('x') }))).toBeUndefined();
  });

  it('華和梨 7 は SHIORI/2.x として扱う', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'kawari.ini': '' }))?.protocol).toBe(2);
    expect(detectNativeEngine('yaya.dll', ghost({}))?.protocol).toBeUndefined();
  });
});
