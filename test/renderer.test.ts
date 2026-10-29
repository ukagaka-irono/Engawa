import { beforeAll, describe, expect, it } from 'vitest';
import type { Shell } from '../src/shell/shell';
import type { SurfacesFile } from '../src/shell/surfaces';

// canvas の無い環境なので、描画は何もしない偽物にする
class FakeCanvas {
  width = 0;
  height = 0;
  style: Record<string, string> = {};
  getContext() {
    return {
      clearRect() {},
      save() {},
      restore() {},
      translate() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      globalCompositeOperation: 'source-over',
    };
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => new FakeCanvas() };
});

const { SurfaceRenderer } = await import('../src/shell/renderer');

/** 指定した ID だけを持つシェル。broken の ID は「定義はあるが読めない」、delay は読み込みの遅さ (ms) */
function fakeShell(name: string, ids: number[], opts: { broken?: number[]; delay?: number } = {}): Shell {
  const surfaces: SurfacesFile = { surfaces: new Map(), aliases: new Map(), version: 1 };
  const ready = new Map<number, { canvas: FakeCanvas } | null>();
  const known = new Set([...ids, ...(opts.broken ?? [])]);
  const compose = (id: number) =>
    new Promise<{ canvas: FakeCanvas } | null>((resolve) =>
      setTimeout(() => {
        const c = opts.broken?.includes(id) ? null : Object.assign(new FakeCanvas(), { width: 100, height: 100 });
        const value = c ? { canvas: c } : null;
        ready.set(id, value);
        resolve(value);
      }, opts.delay ?? 0),
    );
  return {
    name,
    surfaces,
    hasSurface: (id: number) => known.has(id),
    failed: (id: number) => ready.has(id) && ready.get(id) === null,
    compose,
    peek: (id: number) => ready.get(id),
    peekRaw: (id: number) => ready.get(id)?.canvas,
    load: (id: number) => compose(id),
  } as unknown as Shell;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SurfaceRenderer shell changes', () => {
  it('does not loop forever when the current surface cannot be read in the new shell', async () => {
    const a = fakeShell('a', [0]);
    const b = fakeShell('b', [], { broken: [0] });
    const r = new SurfaceRenderer(a, 0);
    r.defaultSurface = () => 0;
    expect(await r.setSurface(0)).toBe(true);
    // 以前は、読めない 0 を出し直し続けてページが固まった
    const result = await Promise.race([r.setShell(b), new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))]);
    expect(result).toBe(false);
    expect(r.strandedIn(b)).toBe(true);
  });

  it('ends on the newest wanted surface after two quick shell changes', async () => {
    const a = fakeShell('a', [3]);
    const b = fakeShell('b', [3], { delay: 20 });
    const c = fakeShell('c', [3], { delay: 5 });
    const r = new SurfaceRenderer(a, 0);
    await r.setSurface(3);
    const first = r.setShell(b);
    await new Promise((res) => setTimeout(res, 2));
    const second = r.setShell(c);
    expect(await second).toBe(true);
    expect(await first).toBe(true); // 後の切り替えに任せた
    expect(r.surfaceId).toBe(3);
    expect(r.strandedIn(c)).toBe(false);
  });

  it('restores the current surface once when a newer \\s fails during a shell change', async () => {
    const a = fakeShell('a', [3]);
    const b = fakeShell('b', [3], { broken: [8], delay: 10 });
    const r = new SurfaceRenderer(a, 0);
    await r.setSurface(3);
    const change = r.setShell(b);
    await tick();
    const s8 = r.setSurface(8);
    expect(await change).toBe(true);
    await s8;
    await new Promise((res) => setTimeout(res, 30));
    expect(r.surfaceId).toBe(3);
    expect(r.strandedIn(b)).toBe(false);
  });

  it('keeps a hidden character hidden when it is asked for a surface that cannot be read', async () => {
    const a = fakeShell('a', [10], { broken: [18] });
    const r = new SurfaceRenderer(a, 1);
    r.defaultSurface = () => 10;
    expect(await r.setSurface(18)).toBe(false);
    expect(r.surfaceId).toBe(-1);
  });

  it('does not let a request still loading in the old shell block hiding in the new one', async () => {
    const a = fakeShell('a', [10, 11], { delay: 30 });
    const b = fakeShell('b', [0]);
    const r = new SurfaceRenderer(a, 1);
    r.defaultSurface = () => 10;
    await r.setSurface(10);
    void r.setSurface(11); // 古いシェルで読み込み中
    expect(await r.setShell(b)).toBe(false); // 新しいシェルには 10 も 11 も無い
    await r.settled(b);
    expect(r.strandedIn(b)).toBe(true);
  });

  it('falls back to the default surface when the new shell lacks the current one', async () => {
    const a = fakeShell('a', [3]);
    const b = fakeShell('b', [0], { broken: [5], delay: 5 });
    const r = new SurfaceRenderer(a, 0);
    r.defaultSurface = () => 0;
    await r.setSurface(3);
    // 3 が無いので false (呼び出し側が既定に戻す)
    expect(await r.setShell(b)).toBe(false);
    expect(await r.setSurface(0)).toBe(true);
    expect(r.surfaceId).toBe(0);
    // 読めない 5 を頼まれても、今の 0 のまま
    expect(await r.setSurface(5)).toBe(false);
    expect(r.surfaceId).toBe(0);
  });
});
