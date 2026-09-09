import { describe, expect, it } from 'vitest';
import { FLASH_MS, TONES, VIBRATIONS } from '@/lib/checkin/feedback';

/**
 * The three feedback channels (spec/checkin.md §12.2).
 *
 * These numbers are a contract with the six people who will learn them by ear
 * over an evening, not tuning knobs — so they are asserted against the spec
 * table rather than left to drift. A change here should be a deliberate edit
 * to a failing test.
 *
 * What these tests cannot cover is the half that decides the door: whether an
 * iPhone actually vibrates (it does not), and whether its ringer switch
 * silences Web Audio. No engine available in CI can answer either. They are
 * settled on the ushers' own handsets through `/scan/diagnostics` before the
 * 18 Sep rehearsal, and this file says so rather than implying the suite has
 * it covered.
 */

describe('the tones of §12.2', () => {
  it('admitted is two ascending notes, 880 → 1320 Hz, 80ms each', () => {
    expect(TONES.admitted).toEqual([
      { hz: 880, ms: 80 },
      { hz: 1320, ms: 80 },
    ]);
  });

  it('already checked in is one note, 440 Hz, 200ms', () => {
    expect(TONES.duplicate).toEqual([{ hz: 440, ms: 200 }]);
  });

  it('error is two descending notes, 300 → 200 Hz, 150ms each', () => {
    expect(TONES.error).toEqual([
      { hz: 300, ms: 150 },
      { hz: 200, ms: 150 },
    ]);
  });

  it('rises for admitted and falls for error, which is the part carried by ear', () => {
    // The absolute frequencies matter less than the direction: in a loud foyer
    // an usher hears "up = in, down = stop" long before they hear pitch.
    expect(TONES.admitted[1].hz).toBeGreaterThan(TONES.admitted[0].hz);
    expect(TONES.error[1].hz).toBeLessThan(TONES.error[0].hz);
  });
});

describe('the vibration patterns of §12.2', () => {
  it('matches the spec exactly', () => {
    expect(VIBRATIONS.admitted).toEqual([60]);
    expect(VIBRATIONS.duplicate).toEqual([40, 60, 40]);
    expect(VIBRATIONS.error).toEqual([200]);
  });

  it('gives every state a distinguishable pattern', () => {
    // A duplicate must not feel like an admission through a coat pocket.
    const shapes = Object.values(VIBRATIONS).map((v) => v.join(','));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('colour, the only channel that is always there', () => {
  it('is held long enough to read at arm`s length', () => {
    expect(FLASH_MS).toBe(800);
  });

  it('has a signature for every tone, so it can carry the result alone', () => {
    // On an iPhone there is no vibration at all, and on a silenced one there
    // may be no sound either. Every tone therefore needs its own colour, or
    // that handset cannot tell two results apart.
    for (const tone of Object.keys(TONES)) {
      expect(VIBRATIONS).toHaveProperty(tone);
    }
    expect(Object.keys(TONES).sort()).toEqual(['admitted', 'duplicate', 'error']);
  });
});
