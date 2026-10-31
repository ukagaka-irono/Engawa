/**
 * 音の左右バランスと、鳴っている音の大きさ・帯域ごとの大きさ (\![sound,…,--balance=]・--spectrum=)。
 * <audio> を Web Audio に通すので、使うときだけ作る (つないだ後は Web Audio からしか鳴らない)。
 * 別のサイトの音で CORS を許していないものは、つなぐと無音になるので、ゴーストのファイルだけに使う。
 */

let shared: AudioContext | undefined;

function context(): AudioContext | undefined {
  if (shared) return shared;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  shared = new Ctor();
  return shared;
}

export interface SpectrumFrame {
  /** チャンネルごとの大きさ (0〜100) */
  channels: number[];
  /** 帯域ごとの大きさ (0〜100。低い音から) */
  bands: number[];
}

export class AudioTap {
  private readonly panner?: StereoPannerNode;
  private readonly analysers: AnalyserNode[] = [];
  private readonly mono?: AnalyserNode;

  private constructor(ctx: AudioContext, audio: HTMLAudioElement) {
    const source = ctx.createMediaElementSource(audio);
    let out: AudioNode = source;
    if (typeof ctx.createStereoPanner === 'function') {
      this.panner = ctx.createStereoPanner();
      out.connect(this.panner);
      out = this.panner;
    }
    out.connect(ctx.destination);
    // 大きさは --balance を掛ける前 (元の波形) で測る
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    for (let i = 0; i < 2; i++) {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      splitter.connect(a, i);
      this.analysers.push(a);
    }
    this.mono = ctx.createAnalyser();
    this.mono.fftSize = 2048;
    source.connect(this.mono);
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  /** 作れなければ (Web Audio が無いなど) undefined */
  static attach(audio: HTMLAudioElement): AudioTap | undefined {
    const ctx = context();
    if (!ctx) return undefined;
    try {
      return new AudioTap(ctx, audio);
    } catch {
      return undefined;
    }
  }

  /** -100 (左) 〜 100 (右) */
  setBalance(value: number): void {
    if (this.panner) this.panner.pan.value = Math.min(1, Math.max(-1, value / 100));
  }

  /** いまの大きさ。bands は帯域の数 (0 なら帯域を測らない) */
  measure(bands: number): SpectrumFrame {
    const channels = this.analysers.map((a) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 141));
    });
    const out: number[] = [];
    if (bands > 0 && this.mono) {
      const bins = new Uint8Array(this.mono.frequencyBinCount);
      this.mono.getByteFrequencyData(bins);
      // 低い音ほど細かく (対数で分ける)
      const lo = 1;
      const hi = bins.length;
      for (let b = 0; b < bands; b++) {
        const from = Math.floor(lo * Math.pow(hi / lo, b / bands));
        const to = Math.max(from + 1, Math.floor(lo * Math.pow(hi / lo, (b + 1) / bands)));
        let sum = 0;
        for (let i = from; i < to && i < bins.length; i++) sum += bins[i];
        out.push(Math.round((sum / (to - from) / 255) * 100));
      }
    }
    return { channels, bands: out };
  }
}
