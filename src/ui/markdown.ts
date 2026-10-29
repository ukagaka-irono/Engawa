import { el } from './dom';

/**
 * ヘルプに README を出すための小さな Markdown 表示。HTML は解釈せず、すべて文字として DOM に入れる。
 * 扱うのは README で使っているものだけ: 見出し・段落・箇条書き・表・コードブロック・`コード`・**太字**・[リンク](URL)。
 * 見出しはダイアログの見出し (h2) の下に来るよう、# を h3 から始める。
 */
export function renderMarkdown(text: string): HTMLElement {
  const root = el('div', { className: 'help-doc' });
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const isBlockStart = (line: string) => /^(#{1,6}\s|```|\|)/.test(line) || /^\s*-\s/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const h = el(`h${Math.min(level + 2, 6)}` as 'h3', { className: `help-h${Math.min(level, 3)}` });
      h.append(...inline(heading[2]));
      root.appendChild(h);
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      root.appendChild(el('pre', {}, el('code', {}, body.join('\n'))));
      continue;
    }

    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const table = el('table');
      // 2行目が |---|---| なら1行目を見出しにする
      const hasHead = rows.length > 1 && rows[1].every((c) => /^:?-+:?$/.test(c));
      if (hasHead) {
        const tr = el('tr');
        for (const c of rows[0]) tr.appendChild(el('th', { scope: 'col' }, ...inline(c)));
        table.appendChild(el('thead', {}, tr));
      }
      const tbody = el('tbody');
      for (const r of rows.slice(hasHead ? 2 : 0)) {
        const tr = el('tr');
        for (const c of r) tr.appendChild(el('td', {}, ...inline(c)));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      root.appendChild(table);
      continue;
    }

    if (/^\s*-\s/.test(line)) {
      const ul = el('ul');
      while (i < lines.length && /^\s*-\s/.test(lines[i])) ul.appendChild(el('li', {}, ...inline(lines[i++].replace(/^\s*-\s+/, ''))));
      root.appendChild(ul);
      continue;
    }

    // 段落。日本語の文なので、行は空白を挟まずにつなぐ
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    root.appendChild(el('p', {}, ...inline(para.join(''))));
  }
  return root;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** `コード`・**太字**・[リンク](URL)。http(s) 以外のリンク (リポジトリ内のファイル) は開けないので文字だけにする */
function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(el('code', {}, m[1]));
    else if (m[2] !== undefined) out.push(el('strong', {}, ...inline(m[2])));
    else if (/^https?:\/\//i.test(m[4])) out.push(el('a', { className: 'link', href: m[4], target: '_blank', rel: 'noopener' }, ...inline(m[3])));
    else out.push(...inline(m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
