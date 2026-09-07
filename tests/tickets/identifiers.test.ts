import { describe, expect, it } from 'vitest';
import {
  bytesToBase62,
  CROCKFORD_ALPHABET,
  formatTicketCode,
  generateQrToken,
  generateTicketCode,
  parseTicketCode,
  QR_TOKEN_LENGTH,
  qrUrl,
} from '@/lib/tickets/identifiers';

/**
 * The two identifiers, before any database is involved.
 *
 * `spec/tickets.md` §10.1. These are the only two strings in the system that
 * cannot be corrected after the fact: `qr_token` is immutable for the life of
 * the attendee (decision 28) and `ticket_code` is printed on paper that has
 * already left the building. Everything here is about properties that must hold
 * on the first attempt.
 */

describe('qr_token', () => {
  it('is 22 characters of base62', () => {
    for (let i = 0; i < 200; i++) {
      const token = generateQrToken();
      expect(token).toHaveLength(QR_TOKEN_LENGTH);
      expect(token).toMatch(/^[0-9A-Za-z]{22}$/);
    }
  });

  it('matches the pattern the scanner extracts by', () => {
    // §10.1 rule 2: the scanner accepts any `[0-9A-Za-z]{22}` run at the end of
    // the decoded string. A token that did not match its own extraction pattern
    // would scan as "not found" at the door, with the ticket in the guest's hand.
    for (let i = 0; i < 200; i++) {
      expect(qrUrl(generateQrToken(), 'https://zetix.vercel.app')).toMatch(
        /[0-9A-Za-z]{22}$/,
      );
    }
  });

  it('does not repeat across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generateQrToken());
    expect(seen.size).toBe(20_000);
  });

  it('uses the whole alphabet rather than a narrow slice of it', () => {
    // A broken encoder that emitted only hex, or only lowercase, would still
    // pass the shape check above while losing most of the 128 bits.
    const chars = new Set<string>();
    for (let i = 0; i < 2_000; i++) for (const c of generateQrToken()) chars.add(c);
    expect(chars.size).toBeGreaterThan(55);
    expect([...chars].some((c) => c >= 'a' && c <= 'z')).toBe(true);
    expect([...chars].some((c) => c >= 'A' && c <= 'Z')).toBe(true);
    expect([...chars].some((c) => c >= '0' && c <= '9')).toBe(true);
  });

  it('is not predictable from position', () => {
    // Two tokens minted back to back must share no positional structure — a
    // counter or a timestamp prefix would make the roster enumerable, and the
    // token is the only thing standing between a guessed URL and a stranger's
    // name and show (§10.1: "unguessable").
    const a = generateQrToken();
    const b = generateQrToken();
    let sharedPrefix = 0;
    while (sharedPrefix < QR_TOKEN_LENGTH && a[sharedPrefix] === b[sharedPrefix]) sharedPrefix++;
    expect(sharedPrefix).toBeLessThan(6);
  });
});

describe('the base62 encoder', () => {
  /**
   * Pinned vectors, checked against a `BigInt` reference implementation over
   * 100,000 random 16-byte inputs at the time of writing.
   *
   * The encoder is hand-rolled long division rather than `BigInt` only because
   * `tsconfig` targets ES2017, which is a poor reason to risk a subtly wrong
   * token — so the arithmetic is pinned here rather than trusted. A token is
   * immutable for life; an off-by-one in the encoder is not something a later
   * fix can reach.
   */
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

  it('matches known vectors', () => {
    expect(bytesToBase62(hex('00000000000000000000000000000000'))).toBe('0');
    expect(bytesToBase62(hex('000000000000000000000000000000ff'))).toBe('47');
    expect(bytesToBase62(hex('ffffffffffffffffffffffffffffffff'))).toBe(
      '7n42DGM5Tflk9n8mt7Fhc7',
    );
    expect(bytesToBase62(hex('0123456789abcdef0123456789abcdef'))).toBe(
      '296tiiBb3U904RIpygpjj',
    );
  });

  it('is injective — distinct inputs never collide', () => {
    // The claim "128 bits of entropy" rests on the encoding being a bijection.
    // A carry bug that folded two byte strings onto one string would quietly
    // halve the space and issue two attendees the same token.
    const seen = new Set<string>();
    for (let i = 0; i < 4096; i++) {
      const bytes = new Uint8Array(16);
      bytes[15] = i & 0xff;
      bytes[14] = (i >> 8) & 0xff;
      seen.add(bytesToBase62(bytes));
    }
    expect(seen.size).toBe(4096);
  });

  it('never exceeds the length the scanner extracts by', () => {
    // 62^22 > 2^128, so 16 bytes can never need a 23rd character. One that did
    // would fall outside the door's `[0-9A-Za-z]{22}` pattern (§10.1 rule 2).
    expect(bytesToBase62(hex('ffffffffffffffffffffffffffffffff'))).toHaveLength(22);
  });
});

describe('ticket_code', () => {
  it('uses Crockford base32 with no I, L, O or U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const banned of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(banned);
    }
  });

  it('reads as PREFIX-XXXX', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTicketCode('ORC')).toMatch(/^ORC-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('never emits a character that can be misread down a phone line', () => {
    // The code exists to be read aloud for support and typed at the door
    // (§10.1). `I`/`1`, `O`/`0`, `L`/`1` and `U`/`V` are the confusions
    // Crockford's alphabet removes; if any leaked in, the failure is a guest
    // who cannot be found while a queue builds behind them.
    const banned = new Set(['I', 'L', 'O', 'U']);
    for (let i = 0; i < 2_000; i++) {
      for (const c of parseTicketCode(generateTicketCode('ORC'))!.body) {
        expect(banned.has(c), `emitted "${c}"`).toBe(false);
      }
    }
  });

  it('spreads across the alphabet', () => {
    const chars = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      for (const c of parseTicketCode(generateTicketCode('ORC'))!.body) chars.add(c);
    }
    // All 32 symbols should appear in 20k draws; a masking bug that dropped the
    // top bit would cap this at 16.
    expect(chars.size).toBe(32);
  });

  it('normalises the Crockford confusables on the way in', () => {
    // Reading is lenient where writing is strict: someone typing a code off
    // paper at the door will type O for 0 and I for 1, and Crockford's whole
    // point is that this is recoverable. Case is folded too.
    expect(parseTicketCode('orc-7k4q')?.normalised).toBe('ORC-7K4Q');
    expect(parseTicketCode('ORC-7K4O')?.normalised).toBe('ORC-7K40');
    expect(parseTicketCode('ORC-7K4I')?.normalised).toBe('ORC-7K41');
    expect(parseTicketCode('ORC-7K4L')?.normalised).toBe('ORC-7K41');
    expect(parseTicketCode('ORC-7K4U')?.normalised).toBe('ORC-7K4V');
  });

  it('accepts a code typed without its hyphen or with stray spacing', () => {
    expect(parseTicketCode('ORC7K4Q')?.normalised).toBe('ORC-7K4Q');
    expect(parseTicketCode('  ORC-7K4Q  ')?.normalised).toBe('ORC-7K4Q');
    expect(parseTicketCode('ORC 7K4Q')?.normalised).toBe('ORC-7K4Q');
  });

  it('rejects what is not a ticket code at all', () => {
    expect(parseTicketCode('')).toBeNull();
    expect(parseTicketCode('ORC-')).toBeNull();
    expect(parseTicketCode('ORC-7K4')).toBeNull();
    expect(parseTicketCode('ORC-7K4QQ')).toBeNull();
    expect(parseTicketCode('7K4Q')).toBeNull();
  });

  it('never turns a short code into a different valid one', () => {
    // Regression. Stripping the hyphen before splitting made `ORC-7K4` — a code
    // typed one character short — parse as prefix `OR`, body `C7K4`: a
    // well-formed code belonging to somebody else. The door would find a guest,
    // just not the one standing at it. A delimiter, where present, decides the
    // split; only its absence licenses splitting from the right.
    expect(parseTicketCode('ORC-7K4')).toBeNull();
    expect(parseTicketCode('ORC-7K')).toBeNull();
    expect(parseTicketCode('ORC 7K4')).toBeNull();
    // The lenient path still works where there is no delimiter to respect.
    expect(parseTicketCode('ORC7K4Q')?.normalised).toBe('ORC-7K4Q');
  });

  it('round-trips whatever it generates', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateTicketCode('ORC');
      expect(parseTicketCode(code)?.normalised).toBe(code);
    }
  });

  it('formats a prefix and body into the canonical shape', () => {
    expect(formatTicketCode('ORC', '7K4Q')).toBe('ORC-7K4Q');
  });
});

describe('qrUrl', () => {
  it('builds the URL the QR encodes', () => {
    expect(qrUrl('abc', 'https://zetix.vercel.app')).toBe(
      'https://zetix.vercel.app/t/abc',
    );
  });

  it('tolerates a trailing slash on the origin', () => {
    // A stray slash would bake `//t/token` into every ticket already printed.
    expect(qrUrl('abc', 'https://zetix.vercel.app/')).toBe(
      'https://zetix.vercel.app/t/abc',
    );
  });

  it('refuses an origin that is not an absolute URL', () => {
    // APP_URL is frozen into every ticket at issue time and cannot be corrected
    // afterwards (§10.1 rule 5, decision 30). Failing loudly at render is the
    // only remaining place to catch a misconfigured environment.
    expect(() => qrUrl('abc', '')).toThrow(/APP_URL/);
    expect(() => qrUrl('abc', 'zetix.vercel.app')).toThrow(/APP_URL/);
    expect(() => qrUrl('abc', '/t')).toThrow(/APP_URL/);
  });
});
