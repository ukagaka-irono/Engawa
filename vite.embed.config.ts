import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transform } from 'lightningcss';
import { defineConfig, type Plugin } from 'vite';
import { BUILD_TARGET } from './vite.config.ts';

/**
 * よそのページに埋め込む版 (dist/engawa-embed.js、入口は src/embed.ts) のビルド。
 * スクリプト1本に、CSS・SHIORI の wasm・Worker をすべて入れる。
 */

const STYLES = fileURLToPath(new URL('./src/styles.css', import.meta.url));

/**
 * styles.css を .engawa-embed の中だけに効くようにする (よそのページの CSS とぶつからないように)。
 * 全体を .engawa-embed { … } で包み、:root を & にして、Lightning CSS で入れ子を普通の CSS に戻す。
 */
function embedCss(): Plugin {
  const id = 'virtual:engawa-embed-css';
  return {
    name: 'engawa-embed-css',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      this.addWatchFile(STYLES);
      const source = readFileSync(STYLES, 'utf-8').replace(/^:root\b/gm, '&');
      const { code } = transform({
        filename: 'styles.css',
        code: Buffer.from(`.engawa-embed {\n${source}\n}\n${EMBED_RULES}`),
        minify: true,
        // Safari 12 / iOS 12、Firefox 78、Chrome 70 (vite.config.ts の BUILD_TARGET と同じ)
        targets: { safari: 12 << 16, ios_saf: 12 << 16, firefox: 78 << 16, chrome: 70 << 16 },
      });
      return `export default ${JSON.stringify(code.toString())};`;
    },
  };
}

/**
 * 埋め込みだけの決まり。入れ物はページ全体に重ねて入力は通し、Engawa の部品だけが入力を受ける。
 * body に書いていた文字の設定は入れ物に移す。タスクバーは出さない (キャラクターは画面の下端に立つ)。
 * キャラクターの上のカーソルは、よそのページの要素の上でも変える (character-layer.ts が html に付けるクラス)。
 */
const EMBED_RULES = `
.engawa-embed {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: var(--font-ui);
  font-size: var(--text-md);
  line-height: normal;
  color: var(--window-text);
  text-align: left;
  -webkit-font-smoothing: antialiased;
  --taskbar-height: 0px;
}
.engawa-embed .taskbar,
.engawa-embed .empty-state,
.engawa-embed .drop-hint {
  display: none;
}
.engawa-embed .dialog,
.engawa-embed .backdrop,
.engawa-embed ._dialog_overlay {
  pointer-events: auto;
}
/* よそのページが要素そのものに付けた文字の色などは受け継がない (Engawa の側は親から受け継ぐ前提で書いてある) */
.engawa-embed h1, .engawa-embed h2, .engawa-embed h3, .engawa-embed h4, .engawa-embed h5, .engawa-embed h6,
.engawa-embed p, .engawa-embed ul, .engawa-embed li, .engawa-embed th, .engawa-embed td, .engawa-embed pre, .engawa-embed code,
.engawa-embed label, .engawa-embed dl, .engawa-embed dt, .engawa-embed dd {
  color: inherit;
  font-family: inherit;
  letter-spacing: normal;
  text-transform: none;
  text-shadow: none;
}
html.over-character,
html.over-character * {
  cursor: pointer !important;
}
`;

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.nar', '**/*.wasm.gz'],
  plugins: [embedCss()],
  build: {
    target: BUILD_TARGET,
    outDir: 'dist',
    // index.html (vite.config.ts のビルド) を残す
    emptyOutDir: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    lib: {
      entry: 'src/embed.ts',
      formats: ['iife'],
      name: 'EngawaEmbed',
      fileName: () => 'engawa-embed.js',
    },
  },
  worker: { format: 'iife' },
});
