import { parseRequestId } from './request-id';
import type { Shiori } from './shiori';

/** 実行できない SHIORI (DLL) の代わり。起動時に一度だけ事情を説明し、あとは何も返さない。 */
export class UnsupportedShiori implements Shiori {
  constructor(readonly name: string) {}

  async load(): Promise<void> {}

  async unload(): Promise<void> {}

  async request(text: string): Promise<string> {
    const id = parseRequestId(text);
    if (id === 'OnBoot' || id === 'OnFirstBoot' || id === 'OnGhostChanged' || id === 'OnGhostCalled') {
      const script =
        `\\0\\s[0]\\_q[Engawa] このゴーストの SHIORI「${this.name.replace(/[\\\]]/g, '')}」はブラウザでは実行できないため、` +
        'シェルの表示のみ行います。\\n\\n右クリックでメニューを開けます。\\e';
      return `SHIORI/3.0 200 OK\r\nCharset: UTF-8\r\nValue: ${script}\r\n\r\n`;
    }
    return 'SHIORI/3.0 204 No Content\r\nCharset: UTF-8\r\n\r\n';
  }
}
