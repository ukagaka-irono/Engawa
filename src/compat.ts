/**
 * 少し古いブラウザ (Safari 12〜14 など) に無い DOM の機能を足す。新しいブラウザでは何もしない。
 * 構文は vite.config.ts の build.target でビルド時に古い書き方へ直す。
 */

if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function (this: Element, ...nodes: (Node | string)[]) {
    while (this.lastChild) this.removeChild(this.lastChild);
    this.append(...nodes);
  };
}

// Blob.arrayBuffer は Safari 14 から
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

export {};
