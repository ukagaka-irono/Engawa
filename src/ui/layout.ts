import { language, translateElements } from '../i18n';

/**
 * ベースウェアの画面の骨組み (デスクトップと、その上のタスクバー・案内・通知の層)。
 * index.html のページ (main.ts) と、よそのページへの埋め込み (embed.ts) の両方がここから作る。
 * 文字は data-i18n のキーで、いまの言語の表から入れる (言語を変えたら translateLayout で入れ直す)。
 */
const MARKUP = `
<div class="desktop"></div>
<div class="overlay">
  <section class="empty-state" aria-labelledby="empty-title" hidden>
    <div class="empty-titlebar" aria-hidden="true">Engawa</div>
    <div class="empty-body">
      <h2 class="empty-title" id="empty-title" data-i18n="layout.noGhostRunning"></h2>
      <p class="empty-text" data-i18n="layout.dropToInstall"></p>
      <div class="empty-actions"><button type="button" class="btn btn-primary" data-i18n="layout.bootGhost"></button></div>
    </div>
  </section>
  <div class="drop-hint" hidden><p data-i18n="layout.dropHint"></p></div>
  <!-- Windows のタスクバー。右端の通知領域にトレイアイコンと時計 -->
  <footer class="taskbar">
    <div class="taskbar-tray">
      <button type="button" class="tray-button" data-i18n-aria-label="layout.menu" title="Engawa" aria-haspopup="menu" aria-expanded="false">
        <span class="tray-icon" aria-hidden="true">縁</span>
      </button>
      <time class="taskbar-clock"></time>
    </div>
  </footer>
</div>`;

export function createLayout(parent: HTMLElement): { desktop: HTMLElement; overlay: HTMLElement } {
  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  parent.appendChild(template.content);
  const overlay = parent.querySelector<HTMLElement>(':scope > .overlay')!;
  translateLayout(overlay);
  return {
    desktop: parent.querySelector<HTMLElement>(':scope > .desktop')!,
    overlay,
  };
}

/** 骨組みの文字をいまの言語にする。ページ (README) は日本語のままなので、lang は画面の層にだけ付ける */
export function translateLayout(overlay: HTMLElement): void {
  overlay.lang = language().code;
  translateElements(overlay);
}
