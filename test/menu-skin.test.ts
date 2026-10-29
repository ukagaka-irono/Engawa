import { describe, expect, it } from 'vitest';
import { Descript } from '../src/package/descript';
import { menuSkin } from '../src/ui/menu-skin';

const url = (path: string) => `blob:${path}`;

describe('menuSkin', () => {
  it('menu.* が無ければ既定の見た目', async () => {
    expect(await menuSkin(Descript.parse('name,test'), url)).toBeUndefined();
  });

  it('色を CSS 変数にし、区切り線は背景の文字色を既定にする', async () => {
    const d = Descript.parse(
      ['menu.background.font.color.r,10', 'menu.background.font.color.g,20', 'menu.background.font.color.b,30', 'menu.frame.color.r,300'].join('\n'),
    );
    const skin = await menuSkin(d, url);
    expect(skin?.vars['--m-text']).toBe('rgb(10, 20, 30)');
    expect(skin?.vars['--m-separator']).toBe('rgb(10, 20, 30)');
    expect(skin?.vars['--m-frame']).toBe('rgb(255, 0, 0)');
  });

  it('画像と揃え方', async () => {
    const d = Descript.parse(
      [
        'menu.background.bitmap.filename,menu_bg.png',
        'menu.background.alignment,rightbottom+repeat-y',
        'menu.foreground.bitmap.filename,menu_fg.png',
      ].join('\n'),
    );
    const skin = await menuSkin(d, url);
    expect(skin?.vars['--m-bg-image']).toBe('url("blob:menu_bg.png")');
    expect(skin?.vars['--m-bg-position']).toBe('right bottom');
    expect(skin?.vars['--m-bg-repeat']).toBe('repeat-y');
    // フォアグラウンドは既定 (lefttop) なので、項目の位置でずらして背景と揃える
    expect(skin?.alignForeground).toBe(true);
    expect(skin?.vars['--m-fg-position']).toBeUndefined();
  });

  it('無いファイルの画像は使わない', async () => {
    const d = Descript.parse('menu.background.bitmap.filename,missing.png');
    expect(await menuSkin(d, () => undefined)).toBeUndefined();
  });
});
