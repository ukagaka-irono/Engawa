import { describe, expect, it } from 'vitest';
import type { Ghost } from '../src/ghost/ghost';
import { handleSstp, parseSstp, scriptFor, type SstpHost } from '../src/ghost/sstp';

/** SSTP を受けるだけの偽のゴースト。再生したスクリプトと送ったイベントを記録する */
function fakeGhost(name: string, sakuraName: string, keroName: string, events: Record<string, string> = {}) {
  const played: { script: string; sender?: string; kinds?: string[] }[] = [];
  const requests: { id: string; refs: unknown[]; headers: Record<string, string> }[] = [];
  const g = {
    name,
    sakuraName,
    keroName,
    key: name,
    uniqueId: `id-${name}`,
    alive: true,
    leaving: false,
    busy: false,
    locked: false,
    isMinimized: false,
    shell: { name: 'master' },
    skin: { name: '内蔵バルーン' },
    shellDirs: ['master'],
    status: () => 'talking',
    property: (p: string) => (p === 'baseware.name' ? 'Engawa' : ''),
    request: async (_m: string, id: string, refs: unknown[], headers: Record<string, string>) => {
      requests.push({ id, refs, headers });
      return events[id];
    },
    playScript: async (script: string, ctx: { sstpSender?: string; kinds?: string[] }) => void played.push({ script, sender: ctx.sstpSender, kinds: ctx.kinds }),
    command: async () => {},
  };
  return { ghost: g as unknown as Ghost, played, requests, raw: g };
}

function host(ghosts: Ghost[], opts: { refused?: boolean } = {}): SstpHost {
  return {
    ghosts: () => ghosts,
    current: () => ghosts[0],
    installed: () => [],
    refused: () => !!opts.refused,
    cookies: {},
    saveCookies: () => {},
    version: '0.1.0',
  };
}

const req = (...lines: string[]) => `${lines.join('\r\n')}\r\n\r\n`;

describe('SSTP', () => {
  it('要求の行とヘッダを読む', () => {
    const r = parseSstp(req('SEND SSTP/1.4', 'Charset: UTF-8', 'Sender: テスト', 'Script: \\h\\s0やあ\\e'));
    expect(r?.method).toBe('SEND');
    expect(r?.version).toBe('1.4');
    expect(r?.headers).toContainEqual(['Script', '\\h\\s0やあ\\e']);
    expect(parseSstp('HELLO')).toBeUndefined();
  });

  it('IfGhost で振り分けたスクリプトを選び、合わなければ既定のもの', () => {
    const r = parseSstp(req('SEND SSTP/1.4', 'Sender: x', 'Script: 既定', 'IfGhost: エミリ,テディ', 'Script: エミリ用', 'IfGhost: ゆかり', 'Script: ゆかり用'))!;
    expect(scriptFor(r, { sakuraName: 'エミリ', keroName: 'テディ' })).toBe('エミリ用');
    expect(scriptFor(r, { sakuraName: 'エミリ', keroName: '別人' })).toBe('既定');
    expect(scriptFor(r, { sakuraName: 'ゆかり', keroName: 'ちゅん' })).toBe('ゆかり用');
  });

  it('SEND はスクリプトを再生し、送り主をマーカーに出す。よそからは remote', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    const res = await handleSstp(req('SEND SSTP/1.4', 'Sender: 送り主', 'Script: \\0こんにちは\\e'), host([a.ghost]), false);
    expect(res.startsWith('SSTP/1.4 200 OK')).toBe(true);
    expect(a.played[0]).toEqual({ script: '\\0こんにちは\\e', sender: '送り主', kinds: ['sstp-send', 'remote'] });
  });

  it('NOTIFY はイベントを送り、返事が無ければ保険のスクリプト。SecurityLevel は external', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    const res = await handleSstp(req('NOTIFY SSTP/1.1', 'Sender: x', 'Event: OnMusicPlay', 'Reference0: 曲', 'Script: 保険'), host([a.ghost]), false);
    expect(res).toContain('200 OK');
    expect(a.requests[0]).toMatchObject({ id: 'OnMusicPlay', refs: ['曲'], headers: { Sender: 'x', SecurityLevel: 'external' } });
    expect(a.played[0].script).toBe('保険');
  });

  it('COMMUNICATE は OnCommunicate (Reference0 = 送り主、1 = 文)', async () => {
    const a = fakeGhost('A', 'あ', 'い', { OnCommunicate: '\\0はい\\e' });
    await handleSstp(req('COMMUNICATE SSTP/1.1', 'Sender: User', 'Sentence: おはよう'), host([a.ghost]), true);
    expect(a.requests[0]).toMatchObject({ id: 'OnCommunicate', refs: ['User', 'おはよう'] });
    expect(a.played[0].kinds).toEqual(['communicate']);
  });

  it('宛先のゴーストがいなければ 404、受けない設定なら 420、\\t の間は 409', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    expect(await handleSstp(req('SEND SSTP/1.4', 'Sender: x', 'ReceiverGhostName: だれか', 'Script: x'), host([a.ghost]), true)).toContain('404');
    expect(await handleSstp(req('SEND SSTP/1.4', 'Sender: x', 'Script: x'), host([a.ghost], { refused: true }), false)).toContain('420');
    a.raw.locked = true;
    expect(await handleSstp(req('SEND SSTP/1.4', 'Sender: x', 'Script: x'), host([a.ghost]), true)).toContain('409');
  });

  it('EXECUTE は名前・状態・プロパティを返す', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    const h = host([a.ghost]);
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: GetName'), h, true)).toMatch(/200 OK[\s\S]*\r\n\r\nあ,い/);
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: GetStatus'), h, true)).toContain('talking');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: GetProperty[baseware.name]'), h, true)).toContain('Engawa');
    await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: SetCookie[k,v]'), h, true);
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: GetCookie[k]'), h, true)).toContain('\r\n\r\nv');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: Unknown'), h, true)).toContain('501');
  });

  it('よそのページからの EXECUTE は名前・状態だけ。プロパティ (ログなど) は読めず、クッキーは送り元ごと', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    const h = host([a.ghost]);
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: GetName'), h, false, 'https://a.example')).toContain('あ,い');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: GetProperty[developer.log.request.index(0).value]'), h, false, 'https://a.example')).toContain('420');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: x', 'Command: SetProperty[currentghost.x,1]'), h, false, 'https://a.example')).toContain('420');
    // 同じ Sender を名乗っても、ほかのオリジンやこのページのクッキーは読めない
    await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: SetCookie[k,local]'), h, true);
    await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: SetCookie[k,a]'), h, false, 'https://a.example');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: GetCookie[k]'), h, false, 'https://b.example')).not.toMatch(/\r\n\r\n(a|local)/);
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: GetCookie[k]'), h, false, 'https://a.example')).toContain('\r\n\r\na');
    expect(await handleSstp(req('EXECUTE SSTP/1.1', 'Sender: アプリ', 'Command: GetCookie[k]'), h, true)).toContain('\r\n\r\nlocal');
  });

  it('送り主の無い SEND と、知らない版は受けない', async () => {
    const a = fakeGhost('A', 'あ', 'い');
    expect(await handleSstp(req('SEND SSTP/1.4', 'Script: x'), host([a.ghost]), true)).toContain('400');
    expect(await handleSstp(req('SEND SSTP/3.0', 'Sender: x', 'Script: x'), host([a.ghost]), true)).toContain('505');
  });
});
