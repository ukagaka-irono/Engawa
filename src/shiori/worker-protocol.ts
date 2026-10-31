/** メインスレッド → SHIORI ワーカー */
export type ToWorker =
  /** node があれば、SHIOLINK で Node.js のプログラムを動かす (argv はプログラムとその引数。node-runtime.ts) */
  | { id: number; type: 'load'; files: [string, Uint8Array][]; entry: string; dir: string; node?: { argv: string[] } }
  | { id: number; type: 'request'; text: string }
  | { id: number; type: 'put'; path: string; data: Uint8Array }
  | { id: number; type: 'unload' }
  /** sstp の答え (id は Worker が付けたもの) */
  | { type: 'sstp-response'; id: number; response: string };

/** SHIORI ワーカー → メインスレッド */
export type FromWorker =
  | { id: number; type: 'result'; ok: true; value?: string }
  | { id: number; type: 'result'; ok: false; error: string }
  | { type: 'write'; path: string; data: Uint8Array }
  | { type: 'log'; message: string }
  /** ベースウェアに SSTP を送る (Node.js のプログラムの SSTP over HTTP)。答えは sstp-response で返す */
  | { type: 'sstp'; id: number; request: string };
