import { describe, expect, it } from 'vitest';
import { detectNativeEngine } from '../src/shiori/native-detect';
import { FileTree } from '../src/vfs/files';

/** Windows の DLL の代わり。中に文字列が入っているだけのバイト列 */
const dll = (...strings: string[]) => new TextEncoder().encode(`MZ\0\0${strings.join('\0')}\0`);
const ghost = (files: Record<string, Uint8Array | string>) =>
  new FileTree(Object.entries(files).map(([p, d]) => [`ghost/master/${p}`, typeof d === 'string' ? new TextEncoder().encode(d) : d]));

describe('detectNativeEngine', () => {
  it('同梱の DLL の中身で見分ける (名前を変えてあっても)', () => {
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('yaya.dll', 'aya5.dll') }))?.id).toBe('yaya');
    expect(detectNativeEngine('aya5.dll', ghost({ 'aya5.dll': dll('aya5.dll') }))?.id).toBe('aya5');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('satori_conf.txt') }))?.id).toBe('satori');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('kawarirc.kis', 'kawari.ini') }))?.id).toBe('kawari');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('kawari.ini') }))?.id).toBe('kawari7');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('Sender: nashi') }))?.id).toBe('nashi');
    expect(detectNativeEngine('shiori.dll', ghost({ 'shiori.dll': dll('talks/main.mnt') }))?.id).toBe('minato');
    expect(detectNativeEngine('kagari.dll', ghost({ 'kagari.dll': dll('index.lua') }))?.id).toBe('kagari');
    expect(detectNativeEngine('quickshiori.dll', ghost({ 'quickshiori.dll': dll('__shiori_request') }))?.id).toBe('quickshiori');
  });

  it('DLL が無ければ名前で、名前でも分からなければ設定ファイルで', () => {
    expect(detectNativeEngine('satori.dll', ghost({}))?.id).toBe('satori');
    expect(detectNativeEngine('YAYA.DLL', ghost({}))?.id).toBe('yaya');
    expect(detectNativeEngine('shiori.dll', ghost({ 'kawarirc.kis': '' }))?.id).toBe('kawari');
    expect(detectNativeEngine('shiori.dll', ghost({ 'talks/main.mnt': '' }))?.id).toBe('minato');
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
