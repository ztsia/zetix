import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createShow, setSystemSetting } from '../helpers/fixtures';
import {
  clientIp,
  consumeRateLimit,
  formBucket,
  portalBucket,
} from '../../src/lib/auth/rate-limit';
import { throttleFormRequest, tooManyRequests } from '@/lib/forms/throttle';

/**
 * Per-IP throttling for the tokenised surfaces (spec/v2.md §8.3, `ref.md` §7).
 *
 * Against the shipping functions and real Postgres. The policy comes from the
 * cascade, so every test seeds it rather than assuming the install seed ran —
 * which also makes the dependency visible: if `resolve_setting` stopped
 * resolving, these fail rather than silently throttling at some other number.
 */

const LIMIT = 3;

async function seedPolicy(perMinute = LIMIT) {
  await setSystemSetting('form.rate_limit_per_ip_per_min', perMinute);
}

/** Backdates a bucket's rows, so a window can expire without waiting a minute. */
async function ageHits(bucket: string, byMs: number) {
  await sql`
    update auth_failures
       set created_at = created_at - ${`${byMs} milliseconds`}::interval
     where bucket = ${bucket}
  `;
}

const rowsIn = async (bucket: string) => {
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from auth_failures where bucket = ${bucket}
  `;
  return Number(row?.n ?? 0);
};

const headersFrom = (ip: string) => new Headers({ 'x-real-ip': ip });

describe('consumeRateLimit', () => {
  beforeEach(async () => {
    await resetDb();
    await seedPolicy();
  });

  it('allows up to the limit and refuses the next one', async () => {
    const bucket = formBucket('203.0.113.5');

    for (let i = 0; i < LIMIT; i++) {
      expect(await consumeRateLimit(bucket)).toEqual({ allowed: true });
    }

    const verdict = await consumeRateLimit(bucket);
    expect(verdict.allowed).toBe(false);
  });

  it('counts the request in hand, so the limit is not off by one', async () => {
    // A check-then-record limiter lets one extra through, and the extra one is
    // always the attacker's.
    const bucket = formBucket('203.0.113.6');
    await seedPolicy(1);

    expect(await consumeRateLimit(bucket)).toEqual({ allowed: true });
    expect((await consumeRateLimit(bucket)).allowed).toBe(false);
  });

  it('keeps buckets separate, so one caller cannot lock out another', async () => {
    await seedPolicy(1);
    expect(await consumeRateLimit(formBucket('203.0.113.7'))).toEqual({ allowed: true });
    expect(await consumeRateLimit(formBucket('203.0.113.8'))).toEqual({ allowed: true });
  });

  it('keeps the form and portal surfaces separate under one policy', async () => {
    await seedPolicy(1);
    const ip = '203.0.113.9';
    expect(await consumeRateLimit(formBucket(ip))).toEqual({ allowed: true });
    // Filling in a form must not lock the same person out of their own ticket.
    expect(await consumeRateLimit(portalBucket(ip))).toEqual({ allowed: true });
  });

  it('does not touch the admin login bucket', async () => {
    await seedPolicy(1);
    const ip = '203.0.113.10';
    await consumeRateLimit(formBucket(ip));
    await consumeRateLimit(formBucket(ip));
    expect(await rowsIn(`admin:${ip}`)).toBe(0);
  });

  it('lets the window slide — a minute later the caller is served again', async () => {
    const bucket = formBucket('203.0.113.11');
    for (let i = 0; i <= LIMIT; i++) await consumeRateLimit(bucket);
    expect((await consumeRateLimit(bucket)).allowed).toBe(false);

    await ageHits(bucket, 61_000);
    expect(await consumeRateLimit(bucket)).toEqual({ allowed: true });
  });

  it('reports how long is actually left, not a flat minute', async () => {
    const bucket = formBucket('203.0.113.12');
    for (let i = 0; i <= LIMIT; i++) await consumeRateLimit(bucket);

    // The oldest hit is 50 seconds old, so the window has ten seconds to run.
    await ageHits(bucket, 50_000);
    const verdict = await consumeRateLimit(bucket);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(11);
  });

  it('never reports zero seconds, which reads as "go ahead"', async () => {
    const bucket = formBucket('203.0.113.13');
    for (let i = 0; i <= LIMIT; i++) await consumeRateLimit(bucket);

    // One second left in the window — the rounding boundary. Anything older
    // than the window is swept instead, and the caller is simply served.
    await ageHits(bucket, 59_000);
    const verdict = await consumeRateLimit(bucket);
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(2);
  });

  it('sweeps its own expired rows, so the table stays bounded without a cron', async () => {
    const bucket = formBucket('203.0.113.14');
    for (let i = 0; i < LIMIT; i++) await consumeRateLimit(bucket);
    expect(await rowsIn(bucket)).toBe(LIMIT);

    await ageHits(bucket, 120_000);
    await consumeRateLimit(bucket);

    // The old ones are gone; only the request in hand remains.
    expect(await rowsIn(bucket)).toBe(1);
  });

  it('sweeps only the caller’s own bucket', async () => {
    const mine = formBucket('203.0.113.15');
    const theirs = formBucket('203.0.113.16');
    await consumeRateLimit(theirs);
    await ageHits(theirs, 120_000);

    await consumeRateLimit(mine);
    expect(await rowsIn(theirs)).toBe(1);
  });

  it('reads the policy through the cascade, so a concert may override it', async () => {
    await seedPolicy(1);
    const concertId = await createConcert();
    await sql`
      update concerts
         set defaults = coalesce(defaults, '{}'::jsonb) || '{"form.rate_limit_per_ip_per_min": 5}'::jsonb
       where id = ${concertId}
    `;
    await createShow(concertId, null);

    const bucket = formBucket('203.0.113.17');
    // The system says one a minute; this concert says five.
    for (let i = 0; i < 5; i++) {
      expect(await consumeRateLimit(bucket, { concertId })).toEqual({ allowed: true });
    }
    expect((await consumeRateLimit(bucket, { concertId })).allowed).toBe(false);
  });

  it('refuses to run at all when nobody has set a policy', async () => {
    await sql`delete from system_settings where key = 'form.rate_limit_per_ip_per_min'`;
    // A limiter that quietly stops limiting is the outcome this module exists
    // to avoid, so a missing seeded policy is loud.
    await expect(consumeRateLimit(formBucket('203.0.113.18'))).rejects.toThrow(
      /form.rate_limit_per_ip_per_min/,
    );
  });
});

describe('clientIp', () => {
  it('reads only headers the platform sets and the caller cannot forge', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '198.51.100.2' }))).toBe('198.51.100.2');
  });

  it('ignores x-forwarded-for, which any client can send', () => {
    // A throttle keyed on a value the attacker chooses is not a throttle: a
    // rotating header is an unlimited supply of fresh buckets.
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.3' }))).toBe('unknown');
  });
});

describe('throttleFormRequest', () => {
  beforeEach(async () => {
    await resetDb();
    await seedPolicy(1);
  });

  it('returns null while the caller may proceed', async () => {
    expect(await throttleFormRequest(headersFrom('198.51.100.10'))).toBeNull();
  });

  it('returns a 429 carrying Retry-After and no-store', async () => {
    const headers = headersFrom('198.51.100.11');
    await throttleFormRequest(headers);

    const response = await throttleFormRequest(headers);
    expect(response).not.toBeNull();
    if (!response) throw new Error('unreachable');

    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.error).toMatch(/too many requests/i);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('throttles per IP, not globally', async () => {
    await throttleFormRequest(headersFrom('198.51.100.12'));
    expect(await throttleFormRequest(headersFrom('198.51.100.12'))).not.toBeNull();
    // Somebody else's phone is unaffected.
    expect(await throttleFormRequest(headersFrom('198.51.100.13'))).toBeNull();
  });
});

describe('tooManyRequests', () => {
  it('is never cached — one caller’s 429 must not become everyone’s', async () => {
    const response = tooManyRequests(42);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
