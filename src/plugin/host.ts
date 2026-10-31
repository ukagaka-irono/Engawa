import type { Ghost } from '../ghost/ghost';
import type { SaoriEffect } from '../saori/context';
import type { Reference } from '../shiori/protocol';
import { copyText } from '../util/clipboard';
import { readPackageFiles, writePackageFile, type PackageMeta } from '../vfs/storage';
import { Plugin } from './plugin';
import type { PluginMethod, PluginResponse } from './protocol';

/** プラグインから見たベースウェア (GhostManager が渡す) */
export interface PluginEnv {
  ghosts(): Ghost[];
  current(): Ghost | undefined;
  installed(): PackageMeta[];
  /** エラーログ (プラグインの名前で) */
  log(name: string, text: string): void;
}

/** ゴーストの側から呼ぶもの (GhostEnv.plugins) */
export interface PluginBridge {
  /** \![raiseplugin] / \![notifyplugin]。送れなかったら理由 (notfound・204 など) を返す */
  call(from: Ghost, target: string, method: PluginMethod, event: string, refs: Reference[]): Promise<string | undefined>;
  /**
   * プラグインが出したスクリプトから起きたイベント (選択肢・アンカー・\![get,property]・\![raise] など) を、そのプラグインに送る。
   * events は試す順 (OnChoiceSelectEx → OnChoiceSelect など)。プラグインが答えたら true
   */
  forward(from: Ghost, pluginId: string, method: PluginMethod, events: [string, Reference[]][]): Promise<boolean>;
  /** ゴーストが話した (OnOtherGhostTalk)。source はそのスクリプトを出したプラグイン */
  talked(from: Ghost, when: 'before' | 'after', refs: Reference[], source?: string): void;
  /** インストールしたプラグインの名前と ID (SHIORI の installedplugin) */
  names(): { name: string; id: string }[];
  /** ゴーストの様子 (シェルなど) が変わった */
  infoUpdated(g: Ghost): void;
}

/** \![raiseplugin] の宛先で、全員を表す名前 */
const ALL_GHOSTS = '__SYSTEM_ALL_GHOST__';

/** 喋り終わるのを待つ (ScriptOption: nobreak) */
async function idle(g: Ghost, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (g.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  return !g.busy;
}

/** プラグインのイベントで渡すゴーストの様子 (HWND は無いので 0・名前・シェル名・ID・パス) */
function ghostRefs(g: Ghost): Reference[] {
  return ['0\x010', g.name, g.shell.name, g.uniqueId, `/${g.key}/`];
}

/**
 * インストールしたプラグインを読み込み、PLUGIN/2.0 のイベントを送り、答えのイベント・スクリプトをゴーストに届ける。
 * ukadoc の spec/plugin・list/plugin-event
 */
export class PluginHost implements PluginBridge {
  private plugins: Plugin[] = [];
  /** OnSecondChange までの残り秒 */
  private readonly countdown = new Map<Plugin, number>();

  constructor(private readonly env: PluginEnv) {}

  list(): Plugin[] {
    return this.plugins;
  }

  names(): { name: string; id: string }[] {
    return this.plugins.map((p) => ({ name: p.name, id: p.id }));
  }

  /** 名前・ID・フォルダ名で探す */
  find(target: string): Plugin | undefined {
    const t = target.trim().toLowerCase();
    return this.plugins.find((p) => p.id.toLowerCase() === t || p.name.toLowerCase() === t || p.meta.dir.toLowerCase() === t);
  }

  /** インストール済みの一覧に合わせる (増えたものを読み込み、消えたもの・入れ直したものを閉じる) */
  async sync(packages: PackageMeta[]): Promise<void> {
    const metas = packages.filter((p) => p.kind === 'plugin');
    for (const p of [...this.plugins]) {
      if (metas.some((m) => m.key === p.key && m.installedAt === p.meta.installedAt)) continue;
      this.plugins.splice(this.plugins.indexOf(p), 1);
      this.countdown.delete(p);
      await p.unload();
    }
    for (const m of metas) {
      if (this.plugins.some((p) => p.key === m.key)) continue;
      let files;
      try {
        files = await readPackageFiles(m.key);
      } catch (e) {
        this.env.log(m.name, `プラグインを読めませんでした: ${(e as Error).message}`);
        continue;
      }
      const plugin = new Plugin(m, files, {
        onWrite: (path, data) => void writePackageFile(m.key, path, data).catch((e) => console.warn('[plugin save]', e)),
        onLog: (text) => this.env.log(plugin.name, text),
        onSaori: (effect) => this.onSaori(plugin, effect),
      });
      this.plugins.push(plugin);
      void this.start(plugin);
    }
  }

  /** 読み込んで、最初の NOTIFY と、起動中のゴーストの OnGhostBoot を送る */
  private async start(plugin: Plugin): Promise<void> {
    const failed = await plugin.load();
    if (failed) {
      this.env.log(plugin.name, failed);
      return;
    }
    if (!this.plugins.includes(plugin)) {
      await plugin.unload();
      return;
    }
    const all = this.env.installed();
    const ghosts = all.filter((p) => p.kind === 'ghost');
    const notify = (id: string, refs: Reference[]) => plugin.request({ method: 'NOTIFY', id, references: refs });
    await notify('installedplugin', this.plugins.map((p) => `${p.name}\x01${p.id}`));
    await notify('installedghostname', [ghosts.map((p) => p.name).join('\x01'), ghosts.map((p) => p.sakuraName ?? p.name).join('\x01'), ghosts.map(() => '').join('\x01')]);
    await notify('installedballoonname', [['内蔵バルーン', ...all.filter((p) => p.kind === 'balloon').map((p) => p.name)].join('\x01')]);
    await notify('ghostpathlist', ['/ghost/']);
    await notify('balloonpathlist', ['/balloon/']);
    await notify('headlinepathlist', ['/headline/']);
    await notify('pluginpathlist', ['/plugin/']);
    this.countdown.set(plugin, plugin.secondInterval);
    for (const g of this.alive()) await this.send(plugin, 'GET', 'OnGhostBoot', ghostRefs(g), g);
  }

  async unloadAll(): Promise<void> {
    const list = this.plugins;
    this.plugins = [];
    this.countdown.clear();
    await Promise.all(list.map((p) => p.unload()));
  }

  // ---------------------------------------------------------------- 本体からのイベント

  ghostBooted(g: Ghost): void {
    for (const p of this.runnable()) void this.send(p, 'GET', 'OnGhostBoot', ghostRefs(g), g);
  }

  ghostExited(g: Ghost): void {
    for (const p of this.runnable()) void this.send(p, 'NOTIFY', 'OnGhostExit', ghostRefs(g));
  }

  infoUpdated(g: Ghost): void {
    for (const p of this.runnable()) void this.send(p, 'NOTIFY', 'OnGhostInfoUpdate', ghostRefs(g));
  }

  /** メニューから実行した */
  menuExec(plugin: Plugin, g: Ghost | undefined): void {
    void this.send(plugin, 'GET', 'OnMenuExec', g ? ghostRefs(g) : ['', '', '', '', ''], g);
  }

  /** インストールが終わった (種類・名前・パスをバイト値1区切りで) */
  installComplete(items: { type: string; name: string; key: string }[]): void {
    const refs = [items.map((i) => i.type).join('\x01'), items.map((i) => i.name).join('\x01'), items.map((i) => `/${i.key}/`).join('\x01')];
    for (const p of this.runnable()) void this.send(p, 'GET', 'OnInstallComplete', refs);
  }

  /** 1秒ごと (secondchangeinterval ごとに OnSecondChange) */
  second(): void {
    for (const p of this.runnable()) {
      if (!p.secondInterval) continue;
      const left = (this.countdown.get(p) ?? p.secondInterval) - 1;
      if (left > 0) {
        this.countdown.set(p, left);
        continue;
      }
      this.countdown.set(p, p.secondInterval);
      void this.send(p, 'GET', 'OnSecondChange', []);
    }
  }

  // ---------------------------------------------------------------- ゴーストから

  async call(from: Ghost, target: string, method: PluginMethod, event: string, refs: Reference[]): Promise<string | undefined> {
    const plugin = this.find(target);
    if (!plugin || !plugin.runnable) return 'notfound';
    const res = await plugin.request({ method, id: event, references: refs, sender: from.name });
    if (!res) return 'notfound';
    // NOTIFY の 204 は普通の答え。GET で何も返さなかったら失敗として知らせる (SSP と同じく実行結果の番号)
    if (method === 'GET' ? res.status !== 200 : res.status >= 300) return String(res.status);
    if (method === 'GET') void this.deliver(plugin, res, from);
    return undefined;
  }

  async forward(from: Ghost, pluginId: string, method: PluginMethod, events: [string, Reference[]][]): Promise<boolean> {
    const plugin = this.plugins.find((p) => p.id === pluginId && p.runnable);
    if (!plugin) return false;
    for (const [id, refs] of events) {
      const res = await plugin.request({ method, id, references: refs });
      if (method === 'GET' && res?.status === 200 && (res.event || res.script)) {
        void this.deliver(plugin, res, from);
        return true;
      }
    }
    return false;
  }

  talked(from: Ghost, when: 'before' | 'after', refs: Reference[], source?: string): void {
    // 自分が出したスクリプトのことは知らせない (知らせると、答えたスクリプトでまた呼ばれ続ける)
    for (const p of this.runnable()) if (p.otherGhostTalk === when && p.id !== source) void this.send(p, 'GET', 'OnOtherGhostTalk', refs, from);
  }

  // ---------------------------------------------------------------- 送る・届ける

  private alive(): Ghost[] {
    return this.env.ghosts().filter((g) => g.alive && !g.leaving);
  }

  private runnable(): Plugin[] {
    return this.plugins.filter((p) => p.runnable);
  }

  private async send(plugin: Plugin, method: PluginMethod, id: string, refs: Reference[], caller?: Ghost): Promise<void> {
    const res = await plugin.request({ method, id, references: refs });
    // NOTIFY の答えのスクリプトは使わない (ukadoc の PLUGIN Event)
    if (res && method === 'GET') await this.deliver(plugin, res, caller);
  }

  /**
   * 答えの Event・Script をゴーストに届ける。宛先は Target (無ければ呼んだゴースト、それも無ければ選択中のゴースト)。
   * Event にゴーストが答えれば、その答えを再生する。答えなければ既定のスクリプト (Script) を再生する
   */
  private async deliver(plugin: Plugin, res: PluginResponse, caller?: Ghost): Promise<void> {
    if (res.status !== 200 || (!res.event && !res.script)) return;
    await Promise.all(this.targets(res.target, caller).map((g) => this.deliverTo(plugin, res, g)));
  }

  private targets(target: string | undefined, caller?: Ghost): Ghost[] {
    const alive = this.alive();
    if (target === ALL_GHOSTS) return alive;
    if (target) {
      const hit = alive.filter((g) => g.name === target || g.sakuraName === target);
      if (hit.length) return hit;
    }
    const cur = this.env.current();
    const one = (caller && alive.includes(caller) ? caller : undefined) ?? (cur && alive.includes(cur) ? cur : undefined) ?? alive[0];
    return one ? [one] : [];
  }

  private async deliverTo(plugin: Plugin, res: PluginResponse, g: Ghost): Promise<void> {
    // Marker はバルーンの SSTP の表示のところに出す (SHIORI の応答の Marker と同じ)
    const marker = res.headers.get('marker') || undefined;
    if (res.event) {
      const notify = res.eventOption.includes('notify');
      const value = await g.request(notify ? 'NOTIFY' : 'GET', res.event, res.references);
      if (value && !notify && g.alive && !g.leaving) {
        void g.playScript(value, { event: res.event, refs: res.references, kinds: ['plugin-event'], plugin: plugin.id, sstpSender: marker });
        return;
      }
    }
    if (!res.script) return;
    if (res.scriptOption.includes('nobreak') && !(await idle(g))) return;
    if (!g.alive || g.leaving) return;
    void g.playScript(res.script, { kinds: ['plugin-script'], noTranslate: res.scriptOption.includes('notranslate'), plugin: plugin.id, sstpSender: marker });
  }

  /** プラグインの SAORI に頼まれたこと (Worker からは触れないもの) */
  private onSaori(plugin: Plugin, effect: SaoriEffect): void {
    if (effect.kind === 'clipboard') void copyText(effect.text);
    else if (effect.kind === 'write') {
      // パスはプラグインのフォルダを ghost/master に置いた形で来る
      const rel = effect.path.replace(/^ghost\/master\//, '');
      plugin.files.set(rel, effect.data);
      void writePackageFile(plugin.key, rel, effect.data).catch((e) => console.warn('[plugin save]', e));
    } else if (effect.kind === 'speak' && typeof speechSynthesis !== 'undefined') {
      if (effect.stop) speechSynthesis.cancel();
      else if (effect.text) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(effect.text), { lang: 'ja-JP' }));
    } else this.env.log(plugin.name, `プラグインの SAORI の ${effect.kind} は使えません`);
  }
}
