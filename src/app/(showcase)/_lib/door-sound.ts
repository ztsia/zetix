import { TONES, type Note } from '@/lib/checkin/feedback';

/**
 * The door's sounds for the landing page's scanner. The admit and repeat tones are the scanner's
 * own (`TONES`, spec/checkin.md §12.2), played with the same envelope: A5 rising to E6, the fifth
 * that string players tune in, and A4 for a ticket already used. The orchestra tunes to that A.
 * The paper tear is noise, shaped. Nothing is fetched.
 *
 * Silent until someone turns sound on: browsers keep audio locked until a gesture, and most people
 * reading this page have it muted anyway.
 */
export type DoorSound = {
  /** Call from inside the click that turns sound on. */
  unlock(): Promise<void>;
  admitted(): void;
  duplicate(): void;
  tear(): void;
  /** The oboe's A, softly, so turning sound on is heard. */
  tuning(): void;
};

export function createDoorSound(): DoorSound {
  let context: AudioContext | null = null;

  function running(): AudioContext | null {
    return context && context.state === 'running' ? context : null;
  }

  return {
    async unlock() {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      context ??= new Ctor();
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
    },
    admitted() {
      const ctx = running();
      if (ctx) notes(ctx, TONES.admitted, 0.25);
    },
    duplicate() {
      const ctx = running();
      if (ctx) notes(ctx, TONES.duplicate, 0.25);
    },
    tuning() {
      const ctx = running();
      if (ctx) swell(ctx, 440, 0.9);
    },
    tear() {
      const ctx = running();
      if (ctx) rip(ctx);
    },
  };
}

/** `playNotes()` in `@/lib/checkin/feedback`: sine notes back to back, 10 ms ramps so none clicks. */
function notes(ctx: AudioContext, sequence: readonly Note[], peak: number) {
  let at = ctx.currentTime;
  for (const note of sequence) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const seconds = note.ms / 1000;
    oscillator.type = 'sine';
    oscillator.frequency.value = note.hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.01);
    gain.gain.setValueAtTime(peak, at + seconds - 0.01);
    gain.gain.linearRampToValueAtTime(0, at + seconds);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + seconds);
    at += seconds;
  }
}

function swell(ctx: AudioContext, hz: number, seconds: number) {
  const at = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.value = hz;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.12, at + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + seconds);
}

/** A quarter of a second of crackling noise through a band-pass, falling away: paper giving. */
function rip(ctx: AudioContext) {
  const seconds = 0.28;
  const frames = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    // Fibres part in bursts: sparse spikes over a bed of hiss, both fading out.
    const burst = Math.random() < 0.035 ? 2.6 : 1;
    data[i] = (Math.random() * 2 - 1) * burst * (1 - t) ** 1.6;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.value = 0.32;
  source.connect(band).connect(gain).connect(ctx.destination);
  source.start();
}
