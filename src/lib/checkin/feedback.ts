import type { FeedbackTone } from './evaluate';

/**
 * Colour, sound and haptics (spec/checkin.md §12.2).
 *
 * Three channels because no single one is reliable in a foyer — and, on this
 * concert's phones, because **one of them does not exist on half the door**.
 * The ushers carry a mix of Android and iPhone (context.md §6 question 7), and
 * iOS has never implemented the Vibration API in any browser: every browser on
 * iOS is WebKit underneath, so switching to Chrome there does not help.
 *
 * That is why the rule below is absolute rather than aspirational:
 *
 * > **Colour must carry the result on its own.**
 *
 * Sound is a supplement — foyers are loud, and on an iPhone whose ringer switch
 * is set to silent, Web Audio may not be audible either. An iPhone in that
 * state has exactly one working channel. The full-screen flash is it, which is
 * why it is full-screen, why it is held for the best part of a second, and why
 * the scanner surface is dark so the colour has the most contrast available.
 */

/** How long the full-screen colour flash is held (§12.2). */
export const FLASH_MS = 800;

export type Note = { hz: number; ms: number };

/**
 * The tones of §12.2, verbatim.
 *
 * Exported as data so `tests/checkin/feedback.test.ts` can hold them against
 * the spec table without a real `AudioContext` — these are a contract with the
 * people who will learn them by ear over an evening, not tuning knobs.
 */
export const TONES: Record<FeedbackTone, readonly Note[]> = {
  admitted: [
    { hz: 880, ms: 80 },
    { hz: 1320, ms: 80 },
  ],
  duplicate: [{ hz: 440, ms: 200 }],
  error: [
    { hz: 300, ms: 150 },
    { hz: 200, ms: 150 },
  ],
};

/** The vibration patterns of §12.2. Android only — see the note above. */
export const VIBRATIONS: Record<FeedbackTone, readonly number[]> = {
  admitted: [60],
  duplicate: [40, 60, 40],
  error: [200],
};

const MUTE_KEY = 'zetix.scanner.muted';

/** What this particular handset can actually do. */
export type FeedbackCapabilities = {
  /** `navigator.vibrate` exists. False on every iPhone. */
  vibration: boolean;
  /** A Web Audio context could be constructed at all. */
  audio: boolean;
  /**
   * The context is running rather than suspended.
   *
   * False until the operator has tapped "Start scanning" — browsers block audio
   * until a user gesture, and iOS is strictest. Without that gesture the first
   * several scans are silent, which is worse than silence throughout because
   * nobody notices until the queue is moving.
   */
  audioUnlocked: boolean;
};

export type ScanFeedback = {
  capabilities(): FeedbackCapabilities;
  /** Call from inside a user gesture. Creates and resumes the AudioContext. */
  unlock(): Promise<void>;
  play(tone: FeedbackTone): void;
  muted(): boolean;
  setMuted(muted: boolean): void;
};

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  // `webkitAudioContext` is still what older iOS exposes.
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function supportsVibration(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function'
  );
}

export function createScanFeedback(): ScanFeedback {
  const Ctor = audioContextCtor();
  let context: AudioContext | null = null;
  let muted = readMuted();

  return {
    capabilities() {
      return {
        vibration: supportsVibration(),
        audio: Ctor !== null,
        audioUnlocked: context?.state === 'running',
      };
    },

    /**
     * **Must run inside the "Start scanning" tap.**
     *
     * Both platforms block audio until a gesture; iOS additionally starts the
     * context suspended and only `resume()` inside a handler moves it. Creating
     * the context lazily on first *scan* instead would put it outside any
     * gesture, which is the exact bug §12.2 warns about.
     */
    async unlock() {
      if (!Ctor) return;
      context ??= new Ctor();
      if (context.state === 'suspended') {
        await context.resume().catch(() => undefined);
      }
    },

    play(tone) {
      // Haptics first: it is the cheapest, and on Android it lands even while
      // the tones are still being scheduled.
      if (supportsVibration()) {
        try {
          navigator.vibrate(VIBRATIONS[tone] as number[]);
        } catch {
          // A browser that exposes the API and refuses the call is not worth
          // failing a scan over.
        }
      }

      if (muted || !context || context.state !== 'running') return;
      playNotes(context, TONES[tone]);
    },

    muted() {
      return muted;
    },

    setMuted(next) {
      muted = next;
      writeMuted(next);
    },
  };
}

/**
 * Two oscillator nodes back to back, with a short ramp at each end.
 *
 * Synthesised rather than loaded from files, so there is nothing to fetch and
 * feedback works on a phone that has been offline since it left the house.
 * The ramps are not decoration: a bare gate on a sine wave clicks, and a click
 * at 80ms is most of what the ear hears.
 */
function playNotes(context: AudioContext, notes: readonly Note[]): void {
  let at = context.currentTime;
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const seconds = note.ms / 1000;

    oscillator.frequency.value = note.hz;
    oscillator.type = 'sine';
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.01);
    gain.gain.setValueAtTime(0.25, at + seconds - 0.01);
    gain.gain.linearRampToValueAtTime(0, at + seconds);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + seconds);
    at += seconds;
  }
}

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    // Private mode, or site data blocked. Defaulting to unmuted is right: the
    // operator can always mute again, and a door that lost its sound silently
    // is worse than one that forgot a preference.
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Preference is per-device and non-critical; losing it costs one tap.
  }
}
