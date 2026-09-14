/**
 * The address checks of `src/lib/email/address.ts`.
 *
 * The cases that matter are the three real addresses from the 10 Sep blast
 * (commit `b426d88`), because they are the reason this module exists and they
 * fail in three different ways:
 *
 * - `zxample.guest@gmail.con` — caught here, by DNS
 * - `zxguest@yahoo.com.my` — **not** caught here, and must not be: the domain
 *   is real and only Yahoo knows the mailbox is dead
 * - `may _zxample@yahoo.com` — caught upstream by `import/plan.ts`, unparseable here
 *
 * DNS is stubbed throughout. A test that resolves a real domain would pass or
 * fail depending on the network, and the behaviour worth pinning is what this
 * does with each *answer*, not whether Google still has MX records.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());

vi.mock('node:dns', () => ({
  promises: { resolveMx, lookup },
}));

const { adviseOnAddress, hasDeliverableDomain, suggestDomainTypo } = await import(
  '@/lib/email/address'
);

/** A DNS rejection carries its verdict in `code`, which is what we branch on. */
function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * `resetAllMocks`, not `clearAllMocks`: the latter keeps implementations, so a
 * `mockRejectedValue` set in one test silently serves the next one that forgot
 * to set its own. That is not hypothetical — it made an earlier version of the
 * whitespace test below pass for entirely the wrong reason.
 */
afterEach(() => {
  vi.resetAllMocks();
});

describe('hasDeliverableDomain', () => {
  it('accepts a domain with MX records', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
    await expect(hasDeliverableDomain('someone@example.test')).resolves.toEqual({ state: 'OK' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects gmail.con — the real bounce, and the case this module is for', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    await expect(hasDeliverableDomain('zxample.guest@gmail.con')).resolves.toEqual({
      state: 'NO_SUCH_DOMAIN',
      domain: 'gmail.con',
    });
  });

  /**
   * RFC 5321 §5.1: no MX means fall back to the A record. Small domains really
   * do run mail this way, and rejecting them would be the one outcome worse
   * than missing a typo.
   */
  it('falls back to the A record when a real domain has no MX', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    lookup.mockResolvedValue({ address: '203.0.113.9', family: 4 });
    await expect(hasDeliverableDomain('someone@a-only.test')).resolves.toEqual({ state: 'OK' });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('treats an empty MX answer the same as ENODATA', async () => {
    resolveMx.mockResolvedValue([]);
    lookup.mockResolvedValue({ address: '203.0.113.9', family: 4 });
    await expect(hasDeliverableDomain('someone@a-only.test')).resolves.toEqual({ state: 'OK' });
  });

  it('rejects only when both MX and A are absent', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    lookup.mockRejectedValue(dnsError('ENOTFOUND'));
    await expect(hasDeliverableDomain('someone@nothing.invalid')).resolves.toEqual({
      state: 'NO_SUCH_DOMAIN',
      domain: 'nothing.invalid',
    });
  });

  /**
   * The fail-open contract, which is the whole design. A registration is worth
   * more than a DNS lookup: refusing a real registrant because a resolver
   * blinked is a worse bug than accepting one typo, and the typo is caught an
   * hour later by an unclicked verification link while the lost registration is
   * caught by nobody.
   */
  describe('fails open — never a verdict it is not certain of', () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'EAI_AGAIN', 'ECONNREFUSED', 'SOMETHING_NEW']) {
      it(`returns UNKNOWN for ${code}, not NO_SUCH_DOMAIN`, async () => {
        resolveMx.mockRejectedValue(dnsError(code));
        const result = await hasDeliverableDomain('someone@example.test');
        expect(result.state).toBe('UNKNOWN');
        expect(lookup).not.toHaveBeenCalled();
      });
    }

    it('returns UNKNOWN when the A fallback is itself inconclusive', async () => {
      resolveMx.mockRejectedValue(dnsError('ENODATA'));
      lookup.mockRejectedValue(dnsError('ETIMEOUT'));
      const result = await hasDeliverableDomain('someone@example.test');
      expect(result.state).toBe('UNKNOWN');
    });

    it('returns UNKNOWN rather than guessing which @ splits an odd address', async () => {
      const result = await hasDeliverableDomain('not-an-address');
      expect(result).toEqual({ state: 'UNKNOWN', domain: null, reason: 'unparseable address' });
      expect(resolveMx).not.toHaveBeenCalled();
    });

    /**
     * `may _zxample@yahoo.com` is the third real address from `b426d88`, and it
     * is **not this module's to catch**: the space is in the local part, so the
     * domain is `yahoo.com` and is genuinely deliverable. Saying `OK` is the
     * honest answer to the question this module asks.
     *
     * The space is caught twice over, by the two layers that own it — the
     * import repairs it, and the dispatcher refuses what it cannot address
     * unambiguously. `z.email()` at the form boundary means this module never
     * sees one in the real flow anyway. Pinned so nobody adds a fourth
     * whitespace check here and calls it defence in depth.
     */
    it('says OK for a good domain even when the local part is malformed', async () => {
      resolveMx.mockResolvedValue([{ exchange: 'mx.yahoo.com', priority: 10 }]);
      await expect(hasDeliverableDomain('may _zxample@yahoo.com')).resolves.toEqual({ state: 'OK' });
      expect(resolveMx).toHaveBeenCalledWith('yahoo.com');
    });
  });

  it('lowercases the domain before asking', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
    await hasDeliverableDomain('Someone@ExAmPle.TEST');
    expect(resolveMx).toHaveBeenCalledWith('example.test');
  });
});

describe('suggestDomainTypo', () => {
  it.each([
    ['gmial.com', 'gmail.com'], // transposition
    ['gmai.com', 'gmail.com'], // deletion
    ['gmaill.com', 'gmail.com'], // insertion
    ['gnail.com', 'gmail.com'], // substitution
    ['hotmial.com', 'hotmail.com'],
    ['outlok.com', 'outlook.com'],
    ['yahooo.com', 'yahoo.com'],
    ['hotmial.co.uk', 'hotmail.co.uk'], // brand typo under a two-part suffix
  ])('suggests %s → %s on a brand typo', (typo, expected) => {
    expect(suggestDomainTypo(`someone@${typo}`)).toBe(expected);
  });

  it.each([
    ['gmail.con', 'gmail.com'], // the real bounce; DNS catches this one too
    ['yahoo.con', 'yahoo.com'],
    ['qq.ocm', 'qq.com'],
    ['126.ocm', '126.com'],
  ])('suggests %s → %s on a suffix that is no real TLD', (typo, expected) => {
    expect(suggestDomainTypo(`someone@${typo}`)).toBe(expected);
  });

  /**
   * A mistyped `.com` is not a real public suffix whoever owns the brand, so
   * this help does not depend on being in {@link COMMON_DOMAINS}. A registrant
   * with a work address gets it too.
   */
  it('fixes a mistyped .com for a brand it has never heard of', () => {
    expect(suggestDomainTypo('someone@some-orchestra-supplier.con')).toBe(
      'some-orchestra-supplier.com',
    );
  });

  /**
   * Damerau, not plain Levenshtein — and these cases prove it bites.
   * A transposition scores 1 here and 2 under plain edit distance, and at six
   * or seven characters a score of 2 is below the threshold, so dropping the
   * transposition arm turns these two null. An earlier version of this suite
   * "tested" Damerau with `gmial.com`, which is 9 characters and passes either
   * way — it proved nothing.
   */
  it.each([
    ['qq.ocm', 'qq.com'],
    ['em.com', 'me.com'],
  ])('needs the transposition arm for %s → %s', (typo, expected) => {
    expect(suggestDomainTypo(`someone@${typo}`)).toBe(expected);
  });

  /**
   * The half that keeps this safe. Being wrong here silently redirects
   * somebody's real address, which is the failure `b426d88` refused to
   * introduce when it declined to rewrite `.con` to `.com`.
   */
  describe('leaves real domains alone', () => {
    it.each([
      'gmail.com',
      'yahoo.com.my', // the other real bounce — real domain, dead mailbox
      'hotmail.co.uk',
      'live.com.my',
      'qq.com',
      '163.com',
      'tm.net.my',
    ])('never questions %s, which is in the known list', (domain) => {
      expect(suggestDomainTypo(`someone@${domain}`)).toBeNull();
    });

    it.each([
      'universiti-malaya.edu.my',
      'orchestra.org',
      'some-company.com.sg',
      'a-very-unusual-domain.test',
    ])('leaves %s alone — far from everything', (domain) => {
      expect(suggestDomainTypo(`someone@${domain}`)).toBeNull();
    });

    /**
     * **The regression that matters most in this file.**
     *
     * Whole-domain edit distance — the obvious implementation, and the one this
     * module started with — "corrected" every one of these. They are the same
     * shape: an identical brand under a different country's suffix, which sits
     * one or two characters from its neighbour *because* the brand matches.
     * `yahoo.co.jp` is Japan's Yahoo and has more users than several entries in
     * the known list.
     *
     * Getting this wrong does not annoy somebody — it tells a registrant with a
     * perfectly good address that it is wrong, and if they take the advice,
     * their tickets go to a stranger at another country's domain. Pinned so no
     * later simplification back to one distance over the whole string survives
     * this file.
     */
    it.each([
      'yahoo.co.jp',
      'yahoo.co.in',
      'yahoo.com.sg',
      'yahoo.com.hk',
      'yahoo.com.au',
      'hotmail.fr',
      'hotmail.co.jp',
      'hotmail.ca',
      'outlook.sg',
      'outlook.de',
      'outlook.com.au',
      'live.co.uk',
      'live.com.sg',
      'live.com.au',
    ])('never corrects %s — a country suffix is not a typo', (domain) => {
      expect(suggestDomainTypo(`someone@${domain}`)).toBeNull();
    });

    /**
     * Real providers that sit within one or two edits of a listed domain. Each
     * is a live false positive under a looser rule, and `mail.com` is the
     * reason {@link COMMON_DOMAINS} still carries a membership guard.
     */
    it.each([
      ['mail.com', 'one edit from gmail.com'],
      ['time.net.my', 'two edits from tm.net.my, and a different ISP'],
      ['naver.com', 'Korea, and nothing like anything listed'],
      ['zoho.com', 'business mail'],
      ['gmx.com', 'Germany'],
    ])('never corrects %s (%s)', (domain) => {
      expect(suggestDomainTypo(`someone@${domain}`)).toBeNull();
    });

    /**
     * `.co` is Colombia's ccTLD and is in wide legitimate use, so it is
     * deliberately absent from the mistyped-`.com` set. An earlier version of
     * this suite expected `icloud.co` → `icloud.com`, which would have
     * redirected every real `.co` address on the form.
     */
    it('treats .co as a real suffix, not a truncated .com', () => {
      expect(suggestDomainTypo('someone@icloud.co')).toBeNull();
      expect(suggestDomainTypo('someone@somestartup.co')).toBeNull();
    });

    /**
     * At six characters two edits is a different domain, not a slip, so the
     * distance-2 rule is gated on length. Without the gate `aa.com` would be
     * "corrected" to `qq.com`.
     */
    it('does not suggest from two edits on a short domain', () => {
      expect(suggestDomainTypo('someone@aa.com')).toBeNull();
    });

    it('does suggest from two edits once the domain is long enough', () => {
      expect(suggestDomainTypo('someone@hotmial.co.uk')).toBe('hotmail.co.uk');
    });
  });

  it('returns null for an address it cannot parse', () => {
    expect(suggestDomainTypo('not-an-address')).toBeNull();
    expect(suggestDomainTypo('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(suggestDomainTypo('Someone@GMIAL.com')).toBe('gmail.com');
  });
});

describe('adviseOnAddress', () => {
  it('names the domain when DNS is certain it does not exist', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    const advice = await adviseOnAddress('zxample.guest@gmail.con');
    expect(advice.blocking).toContain('gmail.con');
    // It is also one edit from gmail.com, so both halves fire on this address.
    expect(advice.suggestion).toBe('gmail.com');
  });

  it('suggests without blocking when DNS is happy but the word is suspicious', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.gmial.com', priority: 10 }]);
    const advice = await adviseOnAddress('someone@gmial.com');
    expect(advice.blocking).toBeNull();
    expect(advice.suggestion).toBe('gmail.com');
  });

  it('says nothing about a good address', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.gmail.com', priority: 10 }]);
    await expect(adviseOnAddress('someone@gmail.com')).resolves.toEqual({
      blocking: null,
      suggestion: null,
    });
  });

  /**
   * `zxguest@yahoo.com.my` really bounced, and this module really cannot see
   * it. Pinned as a test so the next reader does not spend an afternoon trying
   * to make it fail here — the mechanism that catches it is the verification
   * link of §8.1.4, and the admin review screen that lists what never verified.
   */
  it('cannot detect a dead mailbox at a real domain, and does not pretend to', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.yahoo.com.my', priority: 10 }]);
    await expect(adviseOnAddress('zxguest@yahoo.com.my')).resolves.toEqual({
      blocking: null,
      suggestion: null,
    });
  });

  it('stays silent when DNS is unreachable — advice is never a gate', async () => {
    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
    await expect(adviseOnAddress('someone@example.test')).resolves.toEqual({
      blocking: null,
      suggestion: null,
    });
  });
});
