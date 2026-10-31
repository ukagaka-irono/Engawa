/**
 * ベースウェアの画面の骨組み (デスクトップと、その上のタスクバー・案内・通知の層)。
 * index.html のページ (main.ts) と、よそのページへの埋め込み (embed.ts) の両方がここから作る。
 */
const MARKUP = `
<div class="desktop"></div>
<div class="overlay">
  <section class="empty-state" aria-labelledby="empty-title" hidden>
    <div class="empty-titlebar" aria-hidden="true">Engawa</div>
    <div class="empty-body">
      <h2 class="empty-title" id="empty-title">ゴーストが起動していません</h2>
      <p class="empty-text">.nar / .zip ファイルやゴーストのフォルダをここにドロップすると、インストールできます。</p>
      <div class="empty-actions"><button type="button" class="btn btn-primary">ゴーストを起動</button></div>
    </div>
  </section>
  <div class="drop-hint" hidden><p>ドロップしてインストール</p></div>
  <!-- Windows のタスクバー。右端の通知領域にトレイアイコンと時計 -->
  <footer class="taskbar">
    <div class="taskbar-tray">
      <button type="button" class="tray-button" aria-label="メニュー" title="Engawa" aria-haspopup="menu" aria-expanded="false">
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
  return {
    desktop: parent.querySelector<HTMLElement>(':scope > .desktop')!,
    overlay: parent.querySelector<HTMLElement>(':scope > .overlay')!,
  };
}
