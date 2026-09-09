/**
 * Pulling the `qr_token` out of whatever the camera decoded.
 *
 * **This is the load-bearing rule of the door** (decision 28,
 * spec/tickets.md §10.1 rules 1–2, CLAUDE.md). The scanner treats the decoded
 * string as opaque data that happens to look like a URL: it is never fetched,
 * its host is never checked, and its path is never required to be `/t/`. A
 * ticket is printed weeks before the concert and can never be recalled, so the
 * design assumes the origin baked into it **will** one day be wrong — moved,
 * renamed, or simply dead — and makes that survivable rather than fatal.
 *
 * The consequence worth stating plainly: a completely dead `APP_URL` still
 * admits every guest.
 *
 * Rule 2 fixes the order of acceptance, and it is the order below:
 *
 *   1. a bare token;
 *   2. the last path segment of any URL;
 *   3. any `[0-9A-Za-z]{22}` run at the end of the decoded string.
 *
 * Nothing here is `async` and nothing here touches the network. That is the
 * point.
 */

/**
 * 128 bits of CSPRNG entropy rendered base62 (spec/tickets.md §10.1), which is
 * 22 characters. Module `D` mints to exactly this shape and
 * `tests/tickets/identifiers.test.ts` holds it there, so the two ends of the
 * contract are pinned independently.
 */
const TOKEN_LENGTH = 22;

/** A whole string that is nothing but a token. */
const BARE = /^[0-9A-Za-z]{22}$/;

/**
 * A token at the end of the string, as a complete run.
 *
 * The leading group is what stops a 40-character alphanumeric blob yielding its
 * last 22 characters as a "token" — rule 2 says a `[0-9A-Za-z]{22}` **run**,
 * and slicing the tail off a longer one invents an identifier that is not in
 * the manifest and reports a real guest as invalid.
 *
 * **Deliberately a capture group rather than a lookbehind.** `(?<![0-9A-Za-z])`
 * expresses this more directly and is a `SyntaxError` at parse time in Safari
 * before 16.4 — not a failed match, a dead module. The ushers bring their own
 * phones (context.md §6 question 7) so the iOS floor is not ours to pick, and
 * `tests/checkin/token.test.ts` fails if a lookbehind ever appears in this file.
 */
const TRAILING = /(^|[^0-9A-Za-z])([0-9A-Za-z]{22})$/;

/**
 * The token inside `decoded`, or `null` if there is nothing token-shaped in it.
 *
 * `null` is a real answer and the caller renders it as "Invalid ticket" — red,
 * but never a hard block, because the operator can still admit by hand
 * (spec/checkin.md §12.1).
 */
export function extractQrToken(decoded: string): string | null {
  const text = decoded.trim();
  if (text.length === 0) return null;

  // 1. A bare token.
  if (BARE.test(text)) return text;

  // 2. The last path segment of any URL.
  //
  // Parsed with `URL` only to *split* it — the result is never resolved, and no
  // property of the origin is read or compared. A string that does not parse is
  // not an error here; it simply falls through to rule 3, which is why the
  // failure is swallowed rather than reported.
  const url = tryParseUrl(text);
  if (url) {
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const last = segments.at(-1);
    // Percent-decoding is deliberate: a token is base62 and never needs
    // escaping, but a reader that over-encodes its payload would otherwise
    // present `%61B3…` and miss.
    const decodedLast = last ? safeDecode(last) : undefined;
    if (decodedLast && BARE.test(decodedLast)) return decodedLast;
  }

  // 3. A trailing run, for readers that hand back a prefixed payload and for
  //    decoded strings that are not URLs at all.
  const trailing = TRAILING.exec(text);
  if (trailing) return trailing[2];

  return null;
}

function tryParseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not a reason to fail the scan — the raw segment
    // may still be the token.
    return segment;
  }
}

export { TOKEN_LENGTH as QR_TOKEN_LENGTH };
