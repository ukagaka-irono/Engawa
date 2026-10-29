import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * ビルド結果を index.html 1枚にまとめる。
 * file:// で開くと ES モジュールや別ファイルの読み込みはブラウザに止められるので、
 * スクリプトは普通の <script> (IIFE) として、CSS は <style> として埋め込む。
 */
function singleFile(): Plugin {
  return {
    name: 'engawa-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset') return;
      let html = String(page.source);
      const scripts: string[] = [];
      for (const [name, file] of Object.entries(bundle)) {
        const ref = new RegExp(`\\s*<(script|link)\\b[^>]*(?:src|href)="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(?:</script>)?`);
        if (file.type === 'chunk' && file.isEntry) {
          html = html.replace(ref, '');
          // スクリプト中の </script> で HTML が切れないようにする
          scripts.push(file.code.replace(/<\/(script)/gi, '<\\/$1'));
          delete bundle[name];
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          html = html.replace(ref, () => `\n    <style>\n${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      // DOM ができてから動くよう、body の最後に置く
      html = html.replace('</body>', () => scripts.map((code) => `<script>\n${code}</script>\n`).join('') + '</body>');
      page.source = html;
    },
  };
}

// 対応ブラウザ: Firefox、Chrome (Android を含む)、Safari (iOS 12 以降)。vite.embed.config.ts も使う
export const BUILD_TARGET = ['es2018', 'safari12', 'ios12', 'firefox78', 'chrome70'];
export const CSS_TARGET = ['safari12', 'ios12', 'firefox78', 'chrome70'];

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.nar', '**/*.wasm.gz'],
  plugins: [singleFile()],
  build: {
    // ?. や ?? などの新しい構文は Safari 12 が読める書き方に直す (足りない API は src/compat.ts で補う)
    target: BUILD_TARGET,
    cssTarget: CSS_TARGET,
    // サンプルゴーストなどの素材も data: URL として埋め込む
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: { format: 'iife' },
    },
  },
  // SHIORI の Worker も ES モジュールではなく普通のスクリプトにする (Blob から起動する)
  worker: { format: 'iife' },
  test: { environment: 'node' },
});
