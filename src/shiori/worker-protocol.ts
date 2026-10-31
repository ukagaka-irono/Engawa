/** メインスレッド → SHIORI ワーカー */
export type ToWorker =
  | { id: number; type: 'load'; files: [string, Uint8Array][]; entry: string; dir: string }
  | { id: number; type: 'request'; text: string }
  | { id: number; type: 'put'; path: string; data: Uint8Array }
  | { id: number; type: 'unload' };

/** SHIORI ワーカー → メインスレッド */
export type FromWorker =
  | { id: number; type: 'result'; ok: true; value?: string }
  | { id: number; type: 'result'; ok: false; error: string }
  | { type: 'write'; path: string; data: Uint8Array }
  | { type: 'log'; message: string };
