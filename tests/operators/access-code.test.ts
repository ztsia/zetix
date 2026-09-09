import { describe, expect, it } from 'vitest';
import {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_LENGTH,
  generateAccessCode,
} from '@/lib/operators/access-code';

/**
 * The access code is the operator's whole credential (spec/admin.md §14.3), and
 * operator sign-in is deliberately unthrottled — a lockout at the door is the
 * worse failure (F2's handoff). Entropy is therefore the only thing standing
 * between a guessed code and one show's attendee roster, so it is tested rather
 * than assumed.
 */
describe('generateAccessCode', () => {
  it('has no ambiguous glyphs, so an usher can retype it from a screenshot', () => {
    // 0/O and 1/I/L are the pairs that get mistyped off a phone screen in a
    // foyer. There is no decode step to forgive them: the code is a Supabase
    // password and must match character for character.
    for (const forbidden of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(ACCESS_CODE_ALPHABET).not.toContain(forbidden);
    }
  });

  it('is grouped for reading aloud, and the groups are part of the code', () => {
    const code = generateAccessCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('draws every character from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of generateAccessCode().replace(/-/g, '')) {
        expect(ACCESS_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateAccessCode());
    expect(seen.size).toBe(500);
  });

  it('carries enough entropy to survive an unthrottled login', () => {
    const bits = Math.log2(ACCESS_CODE_ALPHABET.length) * ACCESS_CODE_LENGTH;
    expect(bits).toBeGreaterThan(55);
  });

  it('is drawn without modulo bias', () => {
    // Rejection sampling, not `% alphabet.length`: 256 is not a multiple of 30,
    // so a modulo draw would make the first six characters measurably likelier.
    // 24k draws over 30 buckets averages 800; a modulo bias here would show as
    // roughly 900 vs 750, well outside this band.
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateAccessCode().replace(/-/g, '')) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(ACCESS_CODE_ALPHABET.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(660);
      expect(count).toBeLessThan(940);
    }
  });
});
