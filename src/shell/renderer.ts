import { drawWithMethod, type Shell } from './shell';
import { hitCollision, type AnimationDef, type CollisionDef, type PatternDef, type SurfaceDef } from './surfaces';

interface AnimState {
  def: AnimationDef;
  playing: boolean;
  index: number;
  nextAt: number;
  frame?: PatternDef;
  /** start() のたびに増える。パターンの途中で自分自身を開始し直したかの判定用 */
  run: number;
}

const CONTROL = new Set(['start', 'stop', 'alternativestart', 'alternativestop', 'parallelstart', 'parallelstop']);
/** 1フレームで進めるパターン数の上限 (待ち時間 0 のループで固まらないように) */
const MAX_STEPS_PER_TICK = 64;
/** 自分自身を開始し直すループの最短間隔 (ms) */
const MIN_LOOP_MS = 16;

function randomWait([min, max]: [number, number]): number {
  return min === max ? min : min + Math.random() * (max - min);
}

/** 1キャラクター分のサーフェスを canvas に描き、SERIKO アニメーションを進める。 */
export class SurfaceRenderer {
  readonly canvas = document.createElement('canvas');
  surfaceId = -1;
  /** 着せ替え (bind) アニメーションを表示するか */
  bindEnabled: (animId: number) => boolean = () => false;
  /** canvas の大きさが変わった */
  onResize?: () => void;
  /** このキャラクターの既定のサーフェス (シェルの切り替えで今の ID が使えないときの戻り先) */
  defaultSurface: () => number = () => -1;

  private def?: SurfaceDef;
  /** シェルごとの読み込み中の setSurface の数 (古いシェルへの要求は新しいシェルの判定に数えない) */
  private readonly inflight = new Map<Shell, number>();
  /** そのシェルの読み込みが無くなるのを待っている人 */
  private readonly settleWaiters = new Map<Shell, (() => void)[]>();
  private anims = new Map<number, AnimState>();
  private dirty = true;
  private talkCount = 0;
  /** setSurface の世代。待っている間に新しい切り替えが来たら古い方は捨てる */
  private surfaceSeq = 0;
  /** いちばん新しく要求されたサーフェス (読み込み待ちを含む)。シェルを替えるときはこれを出し直す */
  private wanted = -1;
  /** surfaceId / def を適用したときのシェル */
  private appliedShell?: Shell;
  private readonly endWaiters = new Map<number, (() => void)[]>();
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  constructor(
    private shell: Shell,
    readonly scope: number,
  ) {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  get visible(): boolean {
    return this.surfaceId >= 0 && this.canvas.width > 0;
  }

  /** シェルを替えた後、そのシェルで何も出せていない (そのシェルへの読み込み中の要求も無い) */
  strandedIn(shell: Shell): boolean {
    return this.surfaceId >= 0 && this.appliedShell !== shell && !this.inflight.get(shell);
  }

  /** そのシェルへの読み込み中の要求が無くなるまで待つ */
  settled(shell: Shell): Promise<void> {
    if (!this.inflight.get(shell)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settleWaiters.get(shell) ?? [];
      list.push(resolve);
      this.settleWaiters.set(shell, list);
    });
  }

  private track(shell: Shell, delta: 1 | -1): void {
    const n = (this.inflight.get(shell) ?? 0) + delta;
    if (n > 0) {
      this.inflight.set(shell, n);
      return;
    }
    // 0 になったら消す (古いシェルを持ち続けない)
    this.inflight.delete(shell);
    const waiters = this.settleWaiters.get(shell);
    this.settleWaiters.delete(shell);
    waiters?.forEach((w) => w());
  }

  /**
   * シェルを差し替え、同じ ID (切り替え待ちのものがあればそれ) のサーフェスを出し直す。新しいシェルに無ければ false。
   * 読み込みを待つ間も今のサーフェスは消さない (重ねていたコマだけ外す)。
   */
  setShell(shell: Shell): Promise<boolean> {
    const id = this.wanted;
    this.shell = shell;
    this.stopAll();
    for (const st of this.anims.values()) st.frame = undefined;
    this.dirty = true;
    return id >= 0 ? this.setSurface(id) : Promise.resolve(true);
  }

  /**
   * サーフェスを切り替える。存在しない (読めない) ID なら何もしないで false。
   * 待っている間に新しい切り替えが来たときは、そちらに任せて true (「無い」とは区別する)。
   */
  async setSurface(id: number): Promise<boolean> {
    if (id < 0) {
      this.surfaceSeq++;
      this.wanted = -1;
      this.surfaceId = -1;
      this.def = undefined;
      this.appliedShell = undefined;
      this.stopAll();
      this.anims.clear();
      this.dirty = true;
      return true;
    }
    if (!this.shell.hasSurface(id)) return false;
    const seq = ++this.surfaceSeq;
    this.wanted = id;
    const shell = this.shell;
    this.track(shell, 1);
    let composed;
    try {
      composed = await shell.compose(id);
    } finally {
      this.track(shell, -1);
    }
    if (seq !== this.surfaceSeq || shell !== this.shell) return true;
    if (!composed) {
      this.wanted = this.surfaceId;
      // 最新の要求が読めなかった。別のシェルのサーフェスを表示したままのとき (シェルの切り替え途中) だけ、
      // 新しいシェルで出せるもの (今の ID、無いか既に読めなかったなら既定) を出し直す。
      // 読めなかった ID は二度と頼まないので、繰り返しは必ず止まる。隠れているキャラクターは隠れたまま
      if (this.appliedShell && this.appliedShell !== this.shell) {
        const keep = this.surfaceId >= 0 && this.shell.hasSurface(this.surfaceId) && !this.shell.failed(this.surfaceId);
        const restore = keep ? this.surfaceId : this.defaultSurface();
        if (restore >= 0 && restore !== id && !this.shell.failed(restore)) return this.setSurface(restore);
      }
      return false;
    }
    const def = shell.surfaces.surfaces.get(id);
    // アニメーションで使うサーフェスも先読みしておく
    if (def) for (const a of def.animations.values()) for (const p of a.patterns) if (p.surface >= 0) void shell.load(p.surface, p.method === 'asis');
    this.stopAll();
    this.surfaceId = id;
    this.def = def;
    this.appliedShell = shell;
    this.anims = new Map(
      [...(def?.animations.values() ?? [])].map((a) => [a.id, { def: a, playing: false, index: 0, nextAt: 0, run: 0 }]),
    );
    const now = performance.now();
    for (const st of this.anims.values()) {
      if (st.def.intervals.includes('runonce') || st.def.intervals.includes('always')) this.start(st, now);
    }
    // 配置計算で大きさを使うので、次のフレームを待たずに描く
    this.draw();
    return true;
  }

  play(animId: number): void {
    const st = this.anims.get(animId);
    if (st) this.start(st, performance.now());
  }

  /** 停止してフレームも消す (\![anim,stop] と \![anim,clear] はどちらもこれ) */
  clear(animId: number): void {
    const st = this.anims.get(animId);
    if (!st) return;
    this.finish(st);
    st.frame = undefined;
    this.dirty = true;
  }

  isPlaying(animId: number): boolean {
    return this.anims.get(animId)?.playing ?? false;
  }

  waitAnimation(animId: number): Promise<void> {
    if (!this.isPlaying(animId)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.endWaiters.get(animId) ?? [];
      list.push(resolve);
      this.endWaiters.set(animId, list);
    });
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** 1秒ごとの確率起動 (sometimes / rarely / random / periodic)。 */
  secondTick(elapsedSec: number): void {
    const now = performance.now();
    for (const st of this.anims.values()) {
      if (st.playing) continue;
      const { intervals, intervalArg } = st.def;
      const fire =
        (intervals.includes('sometimes') && Math.random() < 1 / 2) ||
        (intervals.includes('rarely') && Math.random() < 1 / 4) ||
        (intervals.includes('random') && intervalArg > 0 && Math.random() < 1 / intervalArg) ||
        (intervals.includes('periodic') && intervalArg > 0 && elapsedSec % intervalArg === 0);
      if (fire) this.start(st, now);
    }
  }

  /** 1文字表示されるたびに呼ばれる (talk,N)。 */
  talk(): void {
    this.talkCount++;
    const now = performance.now();
    for (const st of this.anims.values()) {
      if (st.playing || !st.def.intervals.includes('talk')) continue;
      const n = Math.max(1, st.def.intervalArg);
      if (this.talkCount % n === 0) this.start(st, now);
    }
  }

  /** スクリプトの \e に到達した (yen-e)。 */
  yenE(): void {
    const now = performance.now();
    for (const st of this.anims.values()) if (st.def.intervals.includes('yen-e')) this.start(st, now);
  }

  collisionAt(x: number, y: number): CollisionDef | undefined {
    if (!this.def) return undefined;
    for (const st of [...this.anims.values()].reverse()) {
      if ((st.playing || st.frame) && st.def.collisions.length) {
        const hit = hitCollision(st.def.collisions, x, y);
        if (hit) return hit;
      }
    }
    return hitCollision(this.def.collisions, x, y);
  }

  opaqueAt(x: number, y: number): boolean {
    if (!this.visible || x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return false;
    return this.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 0;
  }

  /** 毎フレーム呼ぶ。タイムラインを進め、変化があれば描き直す。 */
  tick(now: number): void {
    for (const st of this.anims.values()) {
      let steps = 0;
      while (st.playing && now >= st.nextAt && steps++ < MAX_STEPS_PER_TICK) {
        const p = st.def.patterns[st.index];
        const run = st.run;
        if (p) this.applyPattern(st, p, now);
        // パターンが自分自身を開始し直した (start で index が 0 に戻った) ので、ここでは進めない
        if (!st.playing || st.run !== run) continue;
        st.index++;
        if (st.index >= st.def.patterns.length) this.endCycle(st, now);
        else st.nextAt += randomWait(st.def.patterns[st.index].wait);
      }
    }
    if (this.dirty) this.draw();
  }

  /** 最後のパターンまで来た。always なら最初から、それ以外は終了 */
  private endCycle(st: AnimState, now: number): void {
    if (st.def.intervals.includes('always') && st.def.patterns.length > 0) {
      st.index = 0;
      st.nextAt = Math.max(st.nextAt, now) + Math.max(MIN_LOOP_MS, randomWait(st.def.patterns[0].wait));
    } else {
      this.finish(st);
    }
  }

  /** exclusive なアニメーションが再生中で、st の開始を止めているか */
  private blocked(st: AnimState): boolean {
    if (st.def.intervals.includes('bind')) return false;
    for (const o of this.anims.values()) {
      if (o === st || !o.playing || !o.def.exclusive) continue;
      if (o.def.exclusive === true || o.def.exclusive.includes(st.def.id)) return true;
    }
    return false;
  }

  private start(st: AnimState, now: number): void {
    if (st.def.patterns.length === 0 || this.blocked(st)) return;
    const restart = st.playing;
    st.playing = true;
    st.index = 0;
    st.run++;
    // 自分自身を開始し直すときは、待ち時間 0 でも最低 MIN_LOOP_MS 空ける
    const wait = randomWait(st.def.patterns[0].wait);
    st.nextAt = now + (restart ? Math.max(MIN_LOOP_MS, wait) : wait);
    const ex = st.def.exclusive;
    if (ex) {
      // 実行中の他のアニメーションを止める (着せ替えと、終わって残っているコマはそのまま)
      for (const o of this.anims.values()) {
        if (o === st || !o.playing || o.def.intervals.includes('bind')) continue;
        if (ex === true || ex.includes(o.def.id)) {
          this.finish(o);
          o.frame = undefined;
        }
      }
      this.dirty = true;
    }
  }

  private finish(st: AnimState): void {
    if (!st.playing) return;
    st.playing = false;
    const waiters = this.endWaiters.get(st.def.id);
    if (waiters) {
      this.endWaiters.delete(st.def.id);
      waiters.forEach((w) => w());
    }
  }

  private stopAll(): void {
    for (const st of this.anims.values()) this.finish(st);
  }

  private applyPattern(st: AnimState, p: PatternDef, now: number): void {
    if (CONTROL.has(p.method)) {
      const targets = p.ids.map((id) => this.anims.get(id)).filter((a): a is AnimState => !!a);
      const pick = targets[Math.floor(Math.random() * targets.length)];
      switch (p.method) {
        case 'start':
        case 'parallelstart':
          targets.forEach((t) => this.start(t, now));
          break;
        case 'alternativestart':
          if (pick) this.start(pick, now);
          break;
        default:
          targets.forEach((t) => this.finish(t));
      }
      return;
    }
    if (p.surface === -1) {
      // -1: このアニメーションを止める
      st.frame = undefined;
      this.endCycle(st, now);
      // endCycle で always が先頭へ戻った場合も、ここで index を進めないよう run を変える
      st.run++;
    } else if (p.surface === -2) {
      // -2: 実行中の他のアニメーションをすべて止める。このコマ自体は何も描かない
      for (const o of this.anims.values()) {
        if (o === st || !o.playing || o.def.intervals.includes('bind')) continue;
        this.finish(o);
        o.frame = undefined;
      }
      st.frame = undefined;
    } else {
      st.frame = p;
    }
    this.dirty = true;
  }

  private draw(): void {
    this.dirty = false;
    if (this.surfaceId < 0) {
      this.resize(0, 0);
      return;
    }
    const anims = [...this.anims.values()].sort((a, b) => a.def.id - b.def.id);

    // base メソッドのフレームは土台を差し替える (そのサーフェスが無ければ元の土台のまま)
    const baseFrame = anims.filter((a) => a.frame?.method === 'base' && a.frame.surface >= 0).pop()?.frame;
    const own = this.surface(this.surfaceId);
    const base = (baseFrame && this.surface(baseFrame.surface)) || own;
    if (!base) return;
    this.resize(base.width, base.height);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    const move = anims.filter((a) => a.frame?.method === 'move').pop()?.frame;
    if (move) ctx.translate(move.x, move.y);

    const layers = (st: AnimState): void => {
      if (st.def.intervals.includes('bind')) {
        if (!this.bindEnabled(st.def.id)) return;
        for (const p of st.def.patterns) this.drawPattern(p);
      } else if (st.frame && st.frame.method !== 'base' && st.frame.method !== 'move') {
        this.drawPattern(st.frame);
      }
    };
    // background のアニメーションはベースの後ろ (画面奥) にあるので、先に描いてからベースを重ねる
    for (const st of anims) if (st.def.background) layers(st);
    ctx.drawImage(base, 0, 0);
    for (const st of anims) if (!st.def.background) layers(st);
    ctx.restore();
  }

  private drawPattern(p: PatternDef): void {
    if (p.surface < 0 || CONTROL.has(p.method)) return;
    const img = p.method === 'asis' ? this.rawSurface(p.surface) : this.surface(p.surface);
    if (img) drawWithMethod(this.ctx, img, p.method, p.x, p.y);
  }

  private surface(id: number): HTMLCanvasElement | undefined {
    const s = this.shell.peek(id);
    if (s === undefined) {
      // 読み込み中。終わったら描き直す
      void this.shell.load(id).then(() => (this.dirty = true));
      return undefined;
    }
    return s?.canvas;
  }

  private rawSurface(id: number): HTMLCanvasElement | undefined {
    const s = this.shell.peekRaw(id);
    if (s === undefined) {
      void this.shell.load(id, true).then(() => (this.dirty = true));
      return undefined;
    }
    return s ?? undefined;
  }

  private resize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.onResize?.();
  }
}
