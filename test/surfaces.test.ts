import { describe, expect, it } from 'vitest';
import { hitCollision, parseIdSpec, parseSurfaces } from '../src/shell/surfaces';

describe('parseIdSpec', () => {
  it('expands ranges and exclusions', () => {
    expect(parseIdSpec('0,2-4,!3')).toEqual([0, 2, 4]);
  });
});

describe('parseSurfaces', () => {
  const text = `charset,UTF-8
descript
{
version,1
}
// コメント
surface0,1
{
element0,overlay,body.png,0,0
collision0,10,10,50,50,Head
collisionex1,Bust,ellipse,0,60,100,120
animation0.interval,random,4
animation0.pattern0,overlay,100,50,0,0
animation0.pattern1,overlay,-1,50-100,2,3
animation2.interval,never
animation2.pattern0,alternativestart,[3.4]
animation3.interval,never
animation3.option,exclusive,(0,2)
animation4.interval,always
animation4.option,background
}
surface.append1 {
0interval,sometimes
0pattern0,101,5,overlay,0,0
}
sakura.surface.alias
{
5,[0,1]
驚き,[2]
}
`;
  const f = parseSurfaces(text);

  it('reads the version and both surfaces', () => {
    expect(f.version).toBe(1);
    expect([...f.surfaces.keys()].sort()).toEqual([0, 1]);
  });

  it('reads elements and collisions', () => {
    const s = f.surfaces.get(0)!;
    expect(s.elements).toEqual([{ id: 0, method: 'overlay', file: 'body.png', x: 0, y: 0 }]);
    expect(hitCollision(s.collisions, 20, 20)?.name).toBe('Head');
    expect(hitCollision(s.collisions, 50, 90)?.name).toBe('Bust');
    expect(hitCollision(s.collisions, 1, 61)).toBeUndefined();
  });

  it('reads new-style animations with wait ranges and control patterns', () => {
    const a = f.surfaces.get(0)!.animations;
    expect(a.get(0)).toMatchObject({ intervals: ['random'], intervalArg: 4 });
    expect(a.get(0)!.patterns[1]).toMatchObject({ surface: -1, wait: [50, 100], x: 2, y: 3 });
    expect(a.get(2)!.patterns[0]).toMatchObject({ method: 'alternativestart', ids: [3, 4] });
  });

  it('reads exclusive id lists and the background option', () => {
    const a = f.surfaces.get(0)!.animations;
    expect(a.get(3)!.exclusive).toEqual([0, 2]);
    expect(a.get(4)!.background).toBe(true);
    expect(a.get(0)!.exclusive).toBeUndefined();
  });

  it('reads old-style patterns with 10ms waits via surface.append', () => {
    const p = f.surfaces.get(1)!.animations.get(0)!;
    expect(p.intervals).toEqual(['sometimes']);
    expect(p.patterns[0]).toMatchObject({ method: 'overlay', surface: 101, wait: [50, 50] });
  });

  it('reads numeric and named aliases per scope', () => {
    expect(f.aliases.get('sakura')?.get('5')).toEqual([0, 1]);
    expect(f.aliases.get('sakura')?.get('驚き')).toEqual([2]);
  });

  it('accepts MATERIA-style headers', () => {
    const m = parseSurfaces('surface0,surface1,surface2\n{\nelement0,overlay,a.png,0,0\n}\n');
    expect([...m.surfaces.keys()]).toEqual([0, 1, 2]);
  });

  it('applies surface.append only to surfaces that exist, even when defined later', () => {
    const exists = (id: number) => id === 3;
    const m = parseSurfaces(
      'surface.append0-5\n{\ncollision0,0,0,10,10,Head\n}\nsurface1\n{\nelement0,overlay,a.png,0,0\n}\n',
      undefined,
      exists,
    );
    expect([...m.surfaces.keys()].sort()).toEqual([1, 3]);
    expect(m.surfaces.get(1)!.collisions[0]?.name).toBe('Head');
  });
});
