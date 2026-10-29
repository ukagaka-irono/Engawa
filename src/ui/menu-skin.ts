import type { Descript } from '../package/descript';

/**
 * シェルの descript.txt の menu.* (SSP のオーナードローメニューの見た目)。
 * styles.css の .menu が読む CSS 変数 (--m-*) にして返す。指定が1つも無ければ undefined (既定の見た目)。
 */
export interface MenuSkin {
  vars: Record<string, string>;
  /** サイドバーに画像があるか (あれば既定の文字を出さない) */
  sidebarImage: boolean;
  /** フォアグラウンド画像を項目ごとの位置でずらして、メニュー全体に1枚貼ったように見せるか */
  alignForeground: boolean;
}

function color(d: Descript, key: string): string | undefined {
  const parts = ['r', 'g', 'b'].map((c) => d.get(`${key}.${c}`));
  if (parts.every((p) => p === undefined)) return undefined;
  const [r, g, b] = parts.map((p) => Math.min(255, Math.max(0, Number(p) || 0)));
  return `rgb(${r} ${g} ${b})`;
}

/** lefttop / centerbottom / rightcenter+repeat-x などを background-position / repeat にする */
function alignment(value: string | undefined): { position: string; repeat: string; lefttop: boolean } {
  const [place = 'lefttop', ...flags] = (value ?? 'lefttop').toLowerCase().replace(/\s/g, '').split('+');
  const x = place.startsWith('right') ? 'right' : place.startsWith('center') ? 'center' : 'left';
  const y = place.endsWith('bottom') ? 'bottom' : place.endsWith('top') ? 'top' : 'center';
  const rx = flags.includes('repeat-x') || flags.includes('repeat');
  const ry = flags.includes('repeat-y') || flags.includes('repeat');
  return { position: `${x} ${y}`, repeat: rx && ry ? 'repeat' : rx ? 'repeat-x' : ry ? 'repeat-y' : 'no-repeat', lefttop: x === 'left' && y === 'top' };
}

/** 画像の横幅 (サイドバーの幅に使う)。読めなければ undefined */
function imageWidth(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth || undefined);
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}

/** url はシェルのフォルダからの相対パスを画像の URL にする (無いファイルは undefined) */
export async function menuSkin(d: Descript, url: (path: string) => string | undefined): Promise<MenuSkin | undefined> {
  const vars: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== '') vars[name] = value;
  };
  const image = (key: string) => {
    const file = d.get(key);
    return file ? url(file) : undefined;
  };

  const font = d.get('menu.font.name');
  if (font) set('--m-font', `'${font.replace(/['\\]/g, '')}', var(--font-ui)`);
  const height = d.num('menu.font.height', 0);
  if (height > 0) set('--m-size', `${Math.min(height, 48)}px`);

  const text = color(d, 'menu.background.font.color');
  set('--m-text', text);
  set('--m-fg-text', color(d, 'menu.foreground.font.color'));
  set('--m-separator', color(d, 'menu.separator.color') ?? text);
  set('--m-frame', color(d, 'menu.frame.color'));
  set('--m-disable', color(d, 'menu.disable.font.color'));

  const bg = image('menu.background.bitmap.filename');
  if (bg) {
    const a = alignment(d.get('menu.background.alignment'));
    set('--m-bg-image', `url("${bg}")`);
    set('--m-bg-position', a.position);
    set('--m-bg-repeat', a.repeat);
  }

  let alignForeground = false;
  const fg = image('menu.foreground.bitmap.filename');
  if (fg) {
    const a = alignment(d.get('menu.foreground.alignment'));
    set('--m-fg-image', `url("${fg}")`);
    set('--m-fg-repeat', a.repeat);
    // 左上揃えなら、メニューの背景と同じ位置の部分が選択中の項目に見えるようにずらす。
    // それ以外の揃え方は項目ごとに揃える (近似)
    if (a.lefttop) alignForeground = true;
    else set('--m-fg-position', a.position);
  }

  const sidebar = image('menu.sidebar.bitmap.filename');
  if (sidebar) {
    const a = (d.get('menu.sidebar.alignment') ?? 'bottom').toLowerCase();
    set('--m-sidebar-image', `url("${sidebar}")`);
    set('--m-sidebar-position', a.startsWith('top') ? 'center top' : 'center bottom');
    set('--m-sidebar-repeat', a.includes('repeat-y') ? 'repeat-y' : 'no-repeat');
    const w = await imageWidth(sidebar);
    if (w) set('--m-sidebar-width', `${Math.min(w, 96)}px`);
  }

  if (Object.keys(vars).length === 0) return undefined;
  return { vars, sidebarImage: !!sidebar, alignForeground };
}
