import './compat';
import README from '../README.md?raw';
import { GhostManager } from './ghost/manager';
import { createLayout } from './ui/layout';
import { renderMarkdown } from './ui/markdown';

// 如何かのデモページのように、README をページの本文にする (キャラクターはその上に立つ)
document.querySelector('.page')!.replaceChildren(renderMarkdown(README, 1));

const { desktop, overlay } = createLayout(document.querySelector('main')!);

const manager = new GhostManager(desktop, overlay);
void manager.init();
