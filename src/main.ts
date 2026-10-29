import { GhostManager } from './ghost/manager';

const desktop = document.querySelector<HTMLElement>('.desktop')!;
const overlay = document.querySelector<HTMLElement>('.overlay')!;

const manager = new GhostManager(desktop, overlay);
void manager.init();
