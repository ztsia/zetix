import { describe, expect, it } from 'vitest';
import { generateInviteToken, INVITE_TOKEN_LENGTH } from '@/lib/invite-token';

/**
 * The player invite token (spec/domain.md §5.1).
 *
 * Players hold no account, so the token is the whole credential. Both
 * properties below were assumed rather than asserted in the first version of
 * this module, and an independent QA pass found the length one false several
 * percent of the time.
 */
describe('generateInviteToken', () => {
  it('is always exactly 22 characters', () => {
    // `bytesToBase62` encodes the bytes as one big-endian integer, so a value
    // below 62^21 encodes short. Without the padStart this fails on roughly one
    // run in ten — which is worse than failing every time, because it reads as
    // a flaky test rather than a wrong one.
    //
    // 4000 draws makes a missing pad a near-certain catch (p of all-22 by luck
    // is vanishing) while staying instant.
    const lengths = new Set<number>();
    for (let i = 0; i < 4000; i++) lengths.add(generateInviteToken().length);

    expect([...lengths]).toEqual([INVITE_TOKEN_LENGTH]);
  });

  it('uses only base62 characters, so it is safe in a URL unescaped', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateInviteToken()).toMatch(/^[0-9A-Za-z]{22}$/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateInviteToken());
    expect(seen.size).toBe(2000);
  });
});
