import { describe, expect, it } from 'vitest';
import { ghostListProperty, type GhostListEntry } from '../src/ghost/ghostlist';

const descript = (values: Record<string, string>) => ({ str: (key: string) => values[key] ?? '' });

const emily: GhostListEntry = { name: 'Emily/Phase4.5', sakuraName: 'エミリ', path: 'ghost/emily4', keroName: 'テディ', descript: descript({ craftmanw: '作者' }) };
const sample: GhostListEntry = { name: 'ゆかりとちゅん', sakuraName: 'ゆかり', path: 'ghost/sample' };
const installed = [sample, emily];
const active = [emily];
const get = (p: string) => ghostListProperty(p.toLowerCase(), installed, active, 'ghost/emily4');

describe('プロパティの ghostlist・activeghostlist', () => {
  it('ghostlist(…) はゴースト名・本体側名・パスのどれでも探す', () => {
    expect(get('ghostlist(ゆかりとちゅん).sakuraname')).toBe('ゆかり');
    expect(get('ghostlist(ゆかり).path')).toBe('ghost/sample');
    expect(get('ghostlist(ghost/emily4).name')).toBe('Emily/Phase4.5');
    expect(get('ghostlist(Emily/Phase4.5).index')).toBe('1');
    // 番号ではない (番号は ghostlist.index(n))
    expect(get('ghostlist(0).name')).toBe('');
  });

  it('ghostlist.index(n)・ghostlist.current', () => {
    expect(get('ghostlist.index(0).name')).toBe('ゆかりとちゅん');
    expect(get('ghostlist.index(5).name')).toBe('');
    expect(get('ghostlist.current.sakuraname')).toBe('エミリ');
  });

  it('activeghostlist は起動中のゴーストだけ。相方の名前や作者も答える', () => {
    expect(get('activeghostlist(エミリ).keroname')).toBe('テディ');
    expect(get('activeghostlist.index(0).craftmanw')).toBe('作者');
    expect(get('activeghostlist(ゆかり).name')).toBe('');
  });

  it('ほかのプロパティには答えない', () => {
    expect(get('currentghost.name')).toBeUndefined();
  });
});
