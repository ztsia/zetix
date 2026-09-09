import { describe, expect, it } from 'vitest';
import { extractQrToken } from '@/lib/checkin/token';

/**
 * Token extraction — **the load-bearing rule of the whole door** (decision 28,
 * spec/tickets.md §10.1 rule 1 and 2, CLAUDE.md).
 *
 * The scanner never dereferences the QR. It decodes the string, pulls the token
 * out by pattern, and matches the offline manifest. No DNS, no HTTP, no origin
 * comparison. That is what makes a dead, moved, renamed or simply wrong
 * `APP_URL` unable to affect admission — and a ticket printed weeks earlier can
 * never be recalled, so "the URL inside it will one day be wrong" is an
 * assumption, not a risk.
 *
 * Which means the tests that matter here are the ones that prove extraction is
 * **origin-agnostic and path-agnostic**. A change that started validating the
 * host would pass a naive happy-path test and turn away every guest at a door
 * whose domain had moved. Those cases are written first and deliberately.
 */

const TOKEN = 'aB3dEf7hIj9kLm2nOp5qRs';
const OTHER = 'Zy8xWv6utSr4qpOn2mLk0j';

describe('extractQrToken — origin and path are never validated', () => {
  it('takes the token from the origin the tickets were actually rendered with', () => {
    expect(extractQrToken(`https://zetix.vercel.app/t/${TOKEN}`)).toBe(TOKEN);
  });

  it('takes the token from an origin that no longer exists', () => {
    // The whole point of decision 28: this must admit, not fail.
    expect(extractQrToken(`https://old-domain.vercel.app/t/${TOKEN}`)).toBe(TOKEN);
    expect(extractQrToken(`https://tickets.example.org/t/${TOKEN}`)).toBe(TOKEN);
    expect(extractQrToken(`http://192.168.1.4:3000/t/${TOKEN}`)).toBe(TOKEN);
  });

  it('does not require the path to be /t/', () => {
    expect(extractQrToken(`https://example.org/${TOKEN}`)).toBe(TOKEN);
    expect(extractQrToken(`https://example.org/ticket/${TOKEN}`)).toBe(TOKEN);
    expect(extractQrToken(`https://example.org/a/b/c/d/${TOKEN}`)).toBe(TOKEN);
  });

  it('takes a non-/t/ path segment even when the trailing-run rule cannot help', () => {
    /**
     * **This is the assertion with teeth, and the three above do not have it.**
     *
     * A QA mutation that made extraction *require* a `/t/` path left all
     * fourteen of these tests green, because rule 3 — any 22-character run at
     * the end of the string — quietly caught every case rule 2 had dropped. The
     * suite was testing the fallback and reporting it as the path rule.
     *
     * A query string after the token is what separates them: the trailing run
     * is now `1`, so rule 3 cannot fire, and only rule 2 reading the last path
     * segment can return the token. Break rule 2 and this line fails alone.
     */
    expect(extractQrToken(`https://example.org/ticket/${TOKEN}?utm=1`)).toBe(TOKEN);
    expect(extractQrToken(`https://example.org/scan/${TOKEN}?v=2`)).toBe(TOKEN);
  });

  it('accepts a bare token, with no URL around it at all', () => {
    expect(extractQrToken(TOKEN)).toBe(TOKEN);
  });
});

describe('extractQrToken — the shapes a real QR decodes to', () => {
  it('ignores a trailing slash', () => {
    expect(extractQrToken(`https://zetix.vercel.app/t/${TOKEN}/`)).toBe(TOKEN);
  });

  it('ignores a query string and a fragment', () => {
    expect(extractQrToken(`https://zetix.vercel.app/t/${TOKEN}?utm_source=x`)).toBe(TOKEN);
    expect(extractQrToken(`https://zetix.vercel.app/t/${TOKEN}#seat`)).toBe(TOKEN);
  });

  it('trims whitespace a camera or a paste can introduce', () => {
    expect(extractQrToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(extractQrToken(`https://zetix.vercel.app/t/${TOKEN}\n`)).toBe(TOKEN);
  });

  it('preserves case, because base62 is case-sensitive', () => {
    // Lower-casing here would turn every mixed-case token into "not found",
    // which at a door reads as a forged ticket rather than as our bug.
    expect(extractQrToken(TOKEN)).toBe(TOKEN);
    expect(extractQrToken(TOKEN)).not.toBe(TOKEN.toLowerCase());
  });
});

describe('extractQrToken — what it refuses', () => {
  it('returns null rather than guessing', () => {
    expect(extractQrToken('')).toBeNull();
    expect(extractQrToken('   ')).toBeNull();
    expect(extractQrToken('hello world')).toBeNull();
    expect(extractQrToken('https://zetix.vercel.app/')).toBeNull();
    expect(extractQrToken('https://zetix.vercel.app/t/')).toBeNull();
  });

  it('refuses a run that is too short or too long to be a token', () => {
    expect(extractQrToken('aB3dEf7hIj9kLm2nOp5qR')).toBeNull(); // 21
    expect(extractQrToken('aB3dEf7hIj9kLm2nOp5qRsT')).toBeNull(); // 23
  });

  it('does not slice a token out of the tail of a longer alphanumeric run', () => {
    // "any [0-9A-Za-z]{22} run at the end" means a *run* of exactly 22. Taking
    // the last 22 characters of a 40-character run would invent a token that
    // is not in the manifest, and report a real guest as invalid.
    const long = 'a'.repeat(40);
    expect(extractQrToken(long)).toBeNull();
  });

  it('reads the token from a decoded string that is not a URL at all', () => {
    // Rule 2's third case. Some readers hand back the payload with a prefix.
    expect(extractQrToken(`TICKET:${TOKEN}`)).toBe(TOKEN);
    expect(extractQrToken(`ticket ${TOKEN}`)).toBe(TOKEN);
  });

  it('takes the last segment, not the first, when a URL carries two', () => {
    expect(extractQrToken(`https://example.org/${OTHER}/${TOKEN}`)).toBe(TOKEN);
  });
});

describe('extractQrToken — it must not crash an older iPhone', () => {
  it('is built from regexes every shipped Safari can parse', async () => {
    // Lookbehind assertions — (?<=…) and (?<!…) — are a SyntaxError at *parse*
    // time in Safari before 16.4, which would take the whole module down on an
    // older usher phone rather than fail one scan. The ushers bring their own
    // handsets (context.md §6 question 7), so the floor is not ours to choose.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/lib/checkin/token.ts', 'utf8'),
    );
    // Comments stripped first: the file *explains* why it avoids lookbehind,
    // and an explanation must not read as an occurrence. Matching raw source
    // would make the guard fire on its own rationale.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\(\?<[=!]/);
  });
});
