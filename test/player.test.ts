import { describe, expect, it } from 'vitest';
import type { BalloonView } from '../src/balloon/balloon-view';
import { ScriptPlayer, type PlayerHost } from '../src/sakura/player';

/** 文字を集めるだけのバルーンと、\![...] を記録するゴースト側。1文字のウェイトは wait ms */
function fakeHost(wait: number) {
  const text: string[] = [];
  const commands: string[][] = [];
  const balloon = { shown: true, hasChoices: false, write: (ch: string) => text.push(ch) } as unknown as BalloonView;
  const noop = () => {};
  const host: PlayerHost = {
    talkWait: () => wait,
    balloon: () => balloon,
    showBalloon: noop,
    hideBalloon: noop,
    setBalloonId: noop,
    beginScript: noop,
    setSurface: async () => {},
    playAnimation: noop,
    waitAnimation: async () => {},
    talkChar: noop,
    yenE: noop,
    envVar: () => '',
    selectChoice: noop,
    selectAnchor: noop,
    command: async (args) => void commands.push(args),
    openCommunicate: noop,
    playSound: noop,
    waitSound: async () => {},
    openUrl: noop,
    imageUrl: async () => undefined,
    moveScope: async () => {},
    setTimeCritical: noop,
    embed: async () => undefined,
    speak: noop,
  };
  return { host, text, commands };
}

async function timed(script: string, wait: number) {
  const h = fakeHost(wait);
  const start = performance.now();
  await new ScriptPlayer(h.host).play(script);
  return { ...h, ms: performance.now() - start };
}

describe('クイックセクション', () => {
  it('\\![quicksection,true] から \\![quicksection,false] までは、文字をウェイト無しで出す', async () => {
    const quick = await timed('\\![quicksection,true]abcde\\e', 100);
    expect(quick.text.join('')).toBe('abcde');
    expect(quick.ms).toBeLessThan(250);
    // 1 でも始まり、0 で終わる。終わった後の2文字はウェイトがかかる
    const mixed = await timed('\\![quicksection,1]abc\\![quicksection,0]de\\e', 100);
    expect(mixed.text.join('')).toBe('abcde');
    expect(mixed.ms).toBeGreaterThanOrEqual(180);
    // ゴースト側の未対応の命令としては渡さない
    expect([...quick.commands, ...mixed.commands]).toEqual([]);
  });

  it('\\_q は切り替え', async () => {
    const r = await timed('\\_qabcde\\_q\\e', 100);
    expect(r.text.join('')).toBe('abcde');
    expect(r.ms).toBeLessThan(250);
  });
});

describe('失敗するタグ', () => {
  it('Unicode に無い文字コード (\\_u[1.5]・\\&[#x110000]) は何も出さず、再生中のまま止まらない', async () => {
    const h = fakeHost(0);
    let ended = 0;
    h.host.yenE = () => void ended++;
    const player = new ScriptPlayer(h.host);
    const r = await player.play('a\\_u[1.5]b\\&[#x110000]c\\_u[0x41]\\e');
    expect(h.text.join('')).toBe('abcA');
    expect(r.aborted).toBe(false);
    expect(ended).toBe(1);
    expect(player.playing).toBe(false);
  });

  it('ゴースト側で失敗した \\![…] は飛ばして続きを再生する', async () => {
    const h = fakeHost(0);
    h.host.command = async () => {
      throw new Error('boom');
    };
    const player = new ScriptPlayer(h.host);
    await player.play('a\\![raise,OnX]b\\e');
    expect(h.text.join('')).toBe('ab');
    expect(player.playing).toBe(false);
  });
});
