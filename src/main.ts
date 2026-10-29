import README from '../README.md?raw';
import { GhostManager } from './ghost/manager';
import { renderMarkdown } from './ui/markdown';

// 如何かのデモページのように、README をページの本文にする (キャラクターはその上に立つ)
document.querySelector('.page')!.replaceChildren(renderMarkdown(README, 1));

const desktop = document.querySelector<HTMLElement>('.desktop')!;
const overlay = document.querySelector<HTMLElement>('.overlay')!;

const manager = new GhostManager(desktop, overlay);
void manager.init();
