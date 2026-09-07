import { randomBytes } from 'node:crypto';

/**
 * The two ticket identifiers (spec/tickets.md §10.1).
 *
 * These are the only strings in the system that cannot be corrected after the
 * fact. `qr_token` is immutable for the life of the attendee (decision 28), and
 * `ticket_code` is printed on paper that has already left the building. So both
 * generators are deliberately dull, and every property they need is asserted in
 * `tests/tickets/identifiers.test.ts` rather than assumed.
 *
 * No database access here — minting against the unique indexes lives in
 * `mint.ts`, so these stay usable from anywhere and testable without one.
 */

/**
 * Crockford base32: the digits and uppercase letters, less `I`, `L`, `O`, `U`.
 *
 * The exclusions are the point. A `ticket_code` is read aloud for phone support
 * and typed at the door, and `I`/`1`, `L`/`1`, `O`/`0` and `U`/`V` are exactly
 * the pairs that go wrong under those conditions. What it costs is one lookup
 * failing while a queue builds behind the guest.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Base62, in the order that makes the encoding a plain positional numeral. */
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 22 characters, because §10.1 fixes the token at **128 bits of entropy** and
 * 62^21 < 2^128 < 62^22. The scanner extracts by the pattern
 * `[0-9A-Za-z]{22}` (§10.1 rule 2), so this length is part of the door's
 * contract and not a tuning knob.
 */
export const QR_TOKEN_LENGTH = 22;

/** Bytes of entropy behind a token. 16 bytes is the 128 bits §10.1 asks for. */
const QR_TOKEN_BYTES = 16;

/**
 * Symbols in the random half of a `ticket_code`, as in §10.1's `ORC-7K4Q`.
 *
 * Four Crockford symbols is 32^4 ≈ 1.05M codes. At a few hundred tickets per
 * concert the chance of any collision is a couple of percent, and it rises with
 * the lifetime total — which is why minting retries against the unique index
 * rather than trusting the space (`mint.ts`). Widening this to five would make
 * collisions negligible; it also makes the code meaningfully harder to read
 * down a phone, and the retry is cheap. Revisit if the table ever holds ~100k.
 */
const TICKET_CODE_BODY_LENGTH = 4;

/**
 * The default `ticket_code` prefix.
 *
 * Not an operational value in the sense CLAUDE.md bars from code — it is not a
 * capacity, quota, deadline, cap, batch size or rate limit, and no number from
 * `context.md` is involved. It is a format constant, and §10.1 gives it as part
 * of the shape (`ORC-7K4Q`). Every mint takes it as a parameter, so if a future
 * concert needs its own it becomes a settings key without touching a caller.
 */
export const DEFAULT_TICKET_CODE_PREFIX = 'ORC';

/**
 * 128 bits of CSPRNG entropy, base62-encoded.
 *
 * The encoding is a bijection from the 16 random bytes, so the claim "128 bits"
 * is literally true rather than approximately: every distinct byte string maps
 * to a distinct token. Left-padded to a fixed width because a variable-length
 * token would not match the scanner's fixed 22-character extraction pattern.
 */
export function generateQrToken(): string {
  return bytesToBase62(randomBytes(QR_TOKEN_BYTES)).padStart(QR_TOKEN_LENGTH, '0');
}

/**
 * Base-62 encode a byte string, treated as one big-endian integer.
 *
 * Long division over the byte array rather than `BigInt`, because `tsconfig`
 * targets ES2017 and BigInt literals need ES2020 — and raising the target is a
 * change to a file all eight wave-2 branches share, for a gain of about four
 * lines here (spec/modules.md §4).
 *
 * The intermediate `remainder * 256 + byte` peaks at 61 × 256 + 255 = 15,871,
 * far inside exact integer range, so nothing here loses precision.
 */
export function bytesToBase62(bytes: Uint8Array): string {
  const digits = Array.from(bytes);
  const base = BASE62_ALPHABET.length;
  let out = '';
  let start = 0;

  while (start < digits.length) {
    let remainder = 0;
    for (let i = start; i < digits.length; i++) {
      const acc = remainder * 256 + digits[i];
      digits[i] = Math.floor(acc / base);
      remainder = acc % base;
    }
    out = BASE62_ALPHABET[remainder] + out;
    // Leading zero limbs are exhausted, so the next pass can skip them.
    while (start < digits.length && digits[start] === 0) start++;
  }

  return out;
}

/**
 * A human-readable code, e.g. `ORC-7K4Q`.
 *
 * The alphabet is 32 symbols, so five raw bits index it with no modulo bias and
 * no rejection sampling — every symbol is equally likely, which is what keeps
 * the code space the full 32^4 the collision maths above assumes.
 */
export function generateTicketCode(prefix: string = DEFAULT_TICKET_CODE_PREFIX): string {
  const bytes = randomBytes(TICKET_CODE_BODY_LENGTH);
  let body = '';
  for (const byte of bytes) body += CROCKFORD_ALPHABET[byte & 0b11111];
  return formatTicketCode(prefix, body);
}

/** The canonical written form. One place, so the hyphen cannot drift. */
export function formatTicketCode(prefix: string, body: string): string {
  return `${prefix.toUpperCase()}-${body.toUpperCase()}`;
}

/**
 * Crockford's documented input mappings.
 *
 * Reading is lenient where writing is strict, which is the whole reason for the
 * alphabet: someone typing a code off paper at the door **will** type `O` for
 * `0`. Recovering that silently is the feature. Note this runs on input only —
 * nothing here can produce a banned symbol.
 */
const CONFUSABLES: Record<string, string> = {
  O: '0',
  I: '1',
  L: '1',
  U: 'V',
};

export type ParsedTicketCode = {
  /** The canonical `PREFIX-BODY` form, safe to compare against the column. */
  normalised: string;
  prefix: string;
  body: string;
};

/**
 * Parse a code as typed by a human, or return null if it is not one.
 *
 * Accepts a missing hyphen, stray whitespace and any case, because all three
 * are what a person under time pressure at a door actually types. Returns null
 * rather than throwing: at the search box a non-match is an ordinary outcome,
 * not an exceptional one.
 */
export function parseTicketCode(input: string): ParsedTicketCode | null {
  const trimmed = input.trim().toUpperCase();

  /**
   * **A delimiter, where present, decides the split — it is never stripped
   * first.** Removing it and then taking the last four symbols turns `ORC-7K4`,
   * a code typed one character short, into prefix `OR` and body `C7K4`: a
   * well-formed code belonging to a *different* attendee. The door would find
   * somebody, just not the person standing there. Only when there is no
   * delimiter at all is it safe to split from the right.
   */
  const delimiter = trimmed.search(/[\s-]/);
  let prefix: string;
  let rawBody: string;

  if (delimiter >= 0) {
    prefix = trimmed.slice(0, delimiter);
    rawBody = trimmed.slice(delimiter + 1).replace(/[\s-]+/g, '');
  } else {
    if (trimmed.length <= TICKET_CODE_BODY_LENGTH) return null;
    prefix = trimmed.slice(0, trimmed.length - TICKET_CODE_BODY_LENGTH);
    rawBody = trimmed.slice(trimmed.length - TICKET_CODE_BODY_LENGTH);
  }

  if (rawBody.length !== TICKET_CODE_BODY_LENGTH) return null;
  if (!/^[A-Z]+$/.test(prefix)) return null;

  let body = '';
  for (const c of rawBody) {
    const mapped = CONFUSABLES[c] ?? c;
    if (!CROCKFORD_ALPHABET.includes(mapped)) return null;
    body += mapped;
  }

  return { normalised: formatTicketCode(prefix, body), prefix, body };
}

/**
 * The URL the QR encodes: `https://{APP_URL}/t/{qr_token}` (§10.1).
 *
 * **The scanner never dereferences this** (§10.1 rule 1, decision 28) — it
 * extracts the token by pattern and matches the offline manifest, so a wrong or
 * dead origin cannot affect admission. What a wrong origin does break is the
 * portal link, permanently, on every ticket already printed. Since `APP_URL` is
 * frozen before the first render (§10.1 rule 5) and never derived from
 * `VERCEL_URL`, the render is the last place a misconfiguration can still be
 * caught — so this throws rather than producing a plausible-looking string.
 */
export function qrUrl(token: string, appUrl: string): string {
  let origin: URL;
  try {
    origin = new URL(appUrl);
  } catch {
    throw new Error(
      `APP_URL is not an absolute URL: ${JSON.stringify(appUrl)}. It is baked ` +
        'into every ticket at issue time and cannot be corrected afterwards ' +
        '(spec/tickets.md §10.1 rule 5). It must be the Vercel production ' +
        'alias, never VERCEL_URL.',
    );
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error(`APP_URL must be http or https, got ${origin.protocol}`);
  }
  return `${origin.origin}/t/${token}`;
}
