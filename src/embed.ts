/**
 * よそのページに埋め込む Engawa (dist/engawa-embed.js)。ななろだの「おためし起動」のように、
 * Ikagaka.demo (demo.js) を読み込んでいたページで、その代わりに使えるようにする。
 *
 * Ikagaka.demo と同じ名前の関数を window に出す。
 *   install_nar(file, dirpath, sakuraname, type)  nar (type が "url" なら URL、それ以外は Blob) を入れる。起動はしない
 *   boot_nanikamanager()                          入れたゴーストを起動する
 *   halt_nanikamanager()                          すべて閉じる
 *   delete_storage() / delete_database()          入れたものを全部消す
 * 用意ができたら window.onIkagakaReady() を呼ぶ。
 *
 * キャラクターとバルーンはページの上に重ねる (タスクバーは出さない。メニューはキャラクターの右クリック・長押し)。
 * CSS は .engawa-embed の中だけに効くようにしてある (vite.embed.config.ts)。
 * おためしなので、インストールしたものや設定は保存しない (ページを閉じると消える)。
 */
import './compat';
import CSS from 'virtual:engawa-embed-css';
import { GhostManager } from './ghost/manager';
import { useTemporarySettings } from './ghost/settings';
import { setDialogParent } from './ui/dialogs';
import { el, setTokenRoot } from './ui/dom';
import { createLayout } from './ui/layout';
import { filesFromZip } from './vfs/archive';
import { clearMemoryStorage, useMemoryStorage } from './vfs/storage';

declare global {
  interface Window {
    onIkagakaReady?: () => void;
    install_nar?: (file: string | Blob, dirpath?: string, sakuraname?: string, type?: string) => Promise<unknown>;
    boot_nanikamanager?: () => Promise<void>;
    halt_nanikamanager?: () => Promise<void>;
    delete_storage?: () => void;
    delete_database?: () => void;
  }
}

function start(): void {
  useMemoryStorage();
  useTemporarySettings();

  const style = el('style', { textContent: CSS });
  style.dataset.engawa = 'embed';
  document.head.appendChild(style);
  const root = el('div', { className: 'engawa-embed' });
  document.body.appendChild(root);
  setTokenRoot(root);
  setDialogParent(root);

  const { desktop, overlay } = createLayout(root);
  const manager = new GhostManager(desktop, overlay, { embedded: true });
  const ready = manager.init();
  /** 入れたゴースト (boot_nanikamanager で起動するもの) */
  let ghosts: string[] = [];

  async function bytesOf(file: string | Blob, type: string | undefined): Promise<Uint8Array> {
    if (type === 'url' || typeof file === 'string') {
      const res = await fetch(String(file));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  // Ikagaka と同じく、失敗しても reject せずに null を返す (理由は通知とコンソールに出す)
  window.install_nar = async (file, _dirpath, _sakuraname, type) => {
    await ready;
    const name = typeof file === 'string' ? decodeURIComponent(file.split(/[?#]/)[0].split('/').pop() || 'ghost.nar') : (file as File).name || 'ghost.nar';
    try {
      const data = await bytesOf(file, type);
      const result = await manager.install(() => filesFromZip(data), name, { quiet: true });
      if (result?.type === 'ghost' && !ghosts.includes(result.key)) ghosts.push(result.key);
      return result ?? null;
    } catch (e) {
      console.error(`[engawa] install failure: ${name}`, e);
      return null;
    }
  };

  window.boot_nanikamanager = async () => {
    await ready;
    for (const key of ghosts) await manager.bootPackage(key);
  };

  window.halt_nanikamanager = async () => {
    await ready;
    await manager.closeAll();
  };

  // ななろだは await せずに呼んでから install_nar するので、消すのはその場で終える
  window.delete_storage = window.delete_database = () => {
    clearMemoryStorage();
    ghosts = [];
    void manager.reloadPackages();
  };

  void ready.then(() => window.onIkagakaReady?.());
}

if (document.body) start();
else document.addEventListener('DOMContentLoaded', start, { once: true });
