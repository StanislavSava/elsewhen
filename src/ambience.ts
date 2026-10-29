// Ambient sound for each era, made on the fly with WebAudio (no recordings, nothing to license): wind, birds,
// insects, a village hearth's crackle and a city's low hum, mixed by where the slider is and crossfaded as it
// moves. Off until the visitor turns it on (browsers only allow audio after a tap anyway); the choice is
// remembered on this device.

type Layer = "wind" | "birds" | "insects" | "crackle" | "city";
type Mix = Record<Layer, number>;

const SILENT: Mix = { wind: 0, birds: 0, insects: 0, crackle: 0, city: 0 };

/** What each era sounds like. Years in between blend their two neighbours. */
const MIXES: [number, Partial<Mix>][] = [
  [-1_000_000, { wind: 0.5, birds: 0.4, insects: 0.4 }],
  [-10_000, { wind: 0.9, birds: 0.2 }],
  [-2_000, { wind: 0.4, birds: 0.5, crackle: 0.4 }],
  [-500, { wind: 0.3, birds: 0.5, crackle: 0.5 }],
  [-100, { city: 0.35, birds: 0.35, crackle: 0.15 }],
  [-50, { city: 0.55, birds: 0.25 }],
  [0, { city: 0.7, birds: 0.2 }],
  [100, { city: 0.3, birds: 0.6 }],
  [1_000, { birds: 0.8, insects: 0.3, city: 0.1 }],
  [10_000, { wind: 0.5, birds: 0.6, insects: 0.3 }],
  [1_000_000, { wind: 0.4, birds: 0.5, insects: 0.5 }],
];

const mixAt = (year: number): Mix => ({ ...SILENT, ...(MIXES.find(([y]) => y === year)?.[1] ?? {}) });

const STORAGE_KEY = "elsewhen:sound";

class Ambience {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private gains = {} as Record<Layer, GainNode>;
  private mix: Mix = { ...SILENT };
  private noise!: AudioBuffer;
  private timer = 0;
  private active = false;

  get on(): boolean {
    return this.active;
  }

  /** Must be called from a tap or click. */
  async enable(): Promise<void> {
    // iOS mutes Web Audio while the ring/silent switch is on, unless the page asks for playback audio (Safari
    // 16.4+); older versions are unlocked by a media element playing from the same tap.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "playback";
    else void unlockMedia();
    if (!this.ctx) this.build();
    this.active = true;
    await this.ctx!.resume();
    this.master.gain.setTargetAtTime(0.9, this.ctx!.currentTime, 0.4);
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 120);
    try {
      localStorage.setItem(STORAGE_KEY, "on");
    } catch {
      // private mode: the choice just isn't remembered
    }
  }

  disable(): void {
    this.active = false;
    clearInterval(this.timer);
    if (this.ctx) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
      const ctx = this.ctx;
      setTimeout(() => void ctx.suspend(), 600);
    }
    try {
      localStorage.setItem(STORAGE_KEY, "off");
    } catch {
      // see enable()
    }
  }

  /** Whether this visitor turned sound on last time (it still needs a tap to start). */
  wanted(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  }

  /** Follows the slider: keyframes a and b, t of the way from a to b. */
  set(a: number, b: number, t: number): void {
    const ma = mixAt(a);
    const mb = mixAt(b);
    for (const k of Object.keys(SILENT) as Layer[]) this.mix[k] = ma[k] + (mb[k] - ma[k]) * t;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Continuous beds follow the mix; birds and crackle are events, scheduled in tick() by the same numbers.
    // Phone speakers barely play below ~300 Hz, so the beds sit higher and louder than headphones would need.
    this.gains.wind.gain.setTargetAtTime(this.mix.wind * 0.9, now, 0.3);
    this.gains.insects.gain.setTargetAtTime(this.mix.insects * 0.12, now, 0.3);
    this.gains.city.gain.setTargetAtTime(this.mix.city * 1.1, now, 0.3);
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    // Silent while the tab is hidden; back where it was on return.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void ctx.suspend();
      else if (this.active) void ctx.resume();
    });
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    for (const k of Object.keys(SILENT) as Layer[]) {
      this.gains[k] = ctx.createGain();
      this.gains[k].gain.value = 0;
      this.gains[k].connect(this.master);
    }

    // Wind: low-passed noise whose cutoff and level drift slowly, so it gusts.
    const wind = this.loop();
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 700;
    const gust = ctx.createGain();
    gust.gain.value = 0.7;
    this.lfo(0.07, 400, windFilter.frequency);
    this.lfo(0.11, 0.3, gust.gain);
    wind.connect(windFilter).connect(gust).connect(this.gains.wind);

    // Insects: a narrow band of high noise, trembling fast.
    const insects = this.loop();
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 5200;
    band.Q.value = 6;
    const tremble = ctx.createGain();
    tremble.gain.value = 0.6;
    this.lfo(23, 0.4, tremble.gain);
    insects.connect(band).connect(tremble).connect(this.gains.insects);

    // City: the steady wash of distant traffic, centred where a phone speaker can still play it.
    const city = this.loop();
    const rumble = ctx.createBiquadFilter();
    rumble.type = "bandpass";
    rumble.frequency.value = 450;
    rumble.Q.value = 0.7;
    const swell = ctx.createGain();
    swell.gain.value = 0.8;
    this.lfo(0.05, 0.2, swell.gain);
    city.connect(rumble).connect(swell).connect(this.gains.city);
  }

  private loop(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 2);
    return src;
  }

  private lfo(rate: number, depth: number, target: AudioParam): void {
    const osc = this.ctx!.createOscillator();
    osc.frequency.value = rate;
    const amount = this.ctx!.createGain();
    amount.gain.value = depth;
    osc.connect(amount).connect(target);
    osc.start();
  }

  /** Birds and crackle are scattered events, as frequent as the mix asks. */
  private tick(): void {
    if (!this.ctx || document.hidden) return;
    if (Math.random() < this.mix.birds * 0.22) this.bird();
    if (Math.random() < this.mix.crackle * 0.5) this.crackle();
  }

  private bird(): void {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master);
    const base = 2200 + Math.random() * 2600;
    const notes = 2 + Math.floor(Math.random() * 4);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const len = 0.05 + Math.random() * 0.08;
      const f = base * (0.85 + Math.random() * 0.3);
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * (Math.random() < 0.5 ? 1.35 : 0.75), t + len);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.14 * this.mix.birds, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(env).connect(pan);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len + 0.03 + Math.random() * 0.06;
    }
  }

  private crackle(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const env = ctx.createGain();
    const t = ctx.currentTime + Math.random() * 0.1;
    env.gain.setValueAtTime(0.35 * this.mix.crackle * Math.random(), t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    src.connect(hp).connect(env).connect(this.gains.crackle);
    this.gains.crackle.gain.value = 1;
    src.start(t, Math.random() * 1.9, 0.03);
  }
}

/** A tiny silent WAV, played from the tap that turns sound on: older iOS then lets Web Audio through the mute switch. */
async function unlockMedia(): Promise<void> {
  const bytes = new Uint8Array(44 + 2);
  const view = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 38, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2, true);
  const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
  audio.setAttribute("playsinline", "");
  await audio.play().catch(() => undefined);
}

export const ambience = new Ambience();
