import { describe, expect, it } from 'vitest';
import { operatorEmail, operatorSlug } from '../../src/lib/auth/operator-slug';
import { safeRedirect } from '../../src/lib/auth/redirect-target';

/**
 * The operator's synthetic address (spec/checkin.md §12.1, decision 20a).
 *
 * Provisioning (module `H`) and this login both derive the address from the same
 * function. If they ever disagree, an usher simply cannot sign in and nothing
 * says why — so the agreement is what these pin down.
 */
describe('operator slug', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(operatorSlug('Wei Ling')).toBe('wei-ling');
    expect(operatorEmail('Wei Ling')).toBe('wei-ling@operators.invalid');
  });

  it('folds diacritics, so an usher can type their own name plainly', () => {
    expect(operatorSlug('Sïti Nur Aisyah')).toBe(operatorSlug('Siti Nur Aisyah'));
    expect(operatorSlug('José')).toBe('jose');
  });

  it('collapses punctuation and trims the edges', () => {
    expect(operatorSlug("  A/P Devi  ")).toBe('a-p-devi');
    expect(operatorSlug('Tan, Wei-Bee')).toBe('tan-wei-bee');
  });

  it('is stable across case and spacing the admin may not reproduce exactly', () => {
    expect(operatorSlug('WEI  LING')).toBe('wei-ling');
  });

  it('always lands in the reserved .invalid domain', () => {
    // RFC 2606 guarantees it never resolves, which is the point: nothing is ever
    // sent to it and the operator never sees it.
    expect(operatorEmail('Anyone')).toMatch(/@operators\.invalid$/);
  });
});

/**
 * `?next=` arrives from the URL and is therefore attacker-controlled. Without
 * this check the login form becomes an open redirect, which is how a phishing
 * link is made to look like it came from us.
 */
describe('safeRedirect', () => {
  it('accepts a same-site absolute path', () => {
    expect(safeRedirect('/admin/concerts/3/registrations', '/admin')).toBe(
      '/admin/concerts/3/registrations',
    );
  });

  it('rejects an absolute URL to another origin', () => {
    expect(safeRedirect('https://evil.example/steal', '/admin')).toBe('/admin');
  });

  it('rejects a protocol-relative URL', () => {
    // Starts with a slash but browsers read it as another origin.
    expect(safeRedirect('//evil.example/steal', '/admin')).toBe('/admin');
  });

  it('rejects a backslash-obfuscated URL', () => {
    expect(safeRedirect('/\\evil.example', '/admin')).toBe('/admin');
  });

  it('falls back when absent or empty', () => {
    expect(safeRedirect(null, '/admin')).toBe('/admin');
    expect(safeRedirect(undefined, '/admin')).toBe('/admin');
    expect(safeRedirect('', '/admin')).toBe('/admin');
  });
});
