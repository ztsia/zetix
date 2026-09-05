import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../helpers/db';
import { resetDb } from '../helpers/db';
import {
  adminBucket,
  checkRateLimit,
  clearFailures,
  clientIp,
  recordFailure,
  registerFailure,
} from '../../src/lib/auth/rate-limit';

/**
 * The admin login throttle (spec/admin.md §14.3).
 *
 * These exercise the **shipping functions**, not a reimplementation of the rule
 * — the F1 handoff's hardest-won lesson is that a test which imitates the
 * production path proves nothing about it.
 *
 * The policy numbers come from `system_settings`, so each test seeds them
 * explicitly rather than assuming the seed script ran. That also makes the
 * cascade dependency visible: if `requireSetting` stopped resolving, these fail.
 */
const MAX_ATTEMPTS = 3;
const WINDOW_MIN = 10;
const WINDOW_MS = WINDOW_MIN * 60_000;

async function seedPolicy(maxAttempts = MAX_ATTEMPTS, windowMin = WINDOW_MIN) {
  await sql`
    insert into system_settings (key, value) values
      ('auth.admin_max_attempts', ${String(maxAttempts)}::text::jsonb),
      ('auth.admin_lockout_window_min', ${String(windowMin)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** Backdates a bucket's failures, so a lockout can expire without waiting. */
async function ageFailures(bucket: string, byMs: number) {
  await sql`
    update auth_failures
       set created_at = created_at - ${`${byMs} milliseconds`}::interval
     where bucket = ${bucket}
  `;
}

describe('admin login rate limit', () => {
  beforeEach(async () => {
    await resetDb();
    await seedPolicy();
  });

  it('allows attempts below the threshold', async () => {
    const bucket = adminBucket('198.51.100.7');
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await recordFailure(bucket);

    expect(await checkRateLimit(bucket)).toEqual({ allowed: true });
  });

  it('locks out once the threshold is reached', async () => {
    const bucket = adminBucket('198.51.100.7');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(bucket);

    const verdict = await checkRateLimit(bucket);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    // One window, from the most recent failure.
    expect(verdict.retryAfterSeconds).toBeGreaterThan(WINDOW_MS / 1000 - 60);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it('throttles each IP separately', async () => {
    const locked = adminBucket('198.51.100.7');
    const other = adminBucket('203.0.113.9');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(locked);

    expect((await checkRateLimit(locked)).allowed).toBe(false);
    expect((await checkRateLimit(other)).allowed).toBe(true);
  });

  it('grows the lockout as the sign-in route drives it', async () => {
    // Drives the module exactly as `signInAdmin` does — every wrong code goes
    // through `registerFailure`, including ones entered while already locked.
    // Calling `recordFailure` directly here would prove the doubling arithmetic
    // while saying nothing about whether any real caller can reach it.
    const bucket = adminBucket('198.51.100.7');

    let verdict = { allowed: true } as Awaited<ReturnType<typeof registerFailure>>;
    for (let i = 0; i < MAX_ATTEMPTS; i++) verdict = await registerFailure(bucket);
    if (verdict.allowed) throw new Error('expected a lockout at the threshold');
    const first = verdict.retryAfterSeconds;

    // One more wrong code while locked out.
    const second = await registerFailure(bucket);
    if (second.allowed) throw new Error('expected to still be locked out');

    // Doubling, not a flat re-lock.
    expect(second.retryAfterSeconds).toBeGreaterThan(first * 1.5);
  });

  it('reports the lockout on the attempt that causes it, not the next one', async () => {
    const bucket = adminBucket('198.51.100.7');
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      expect((await registerFailure(bucket)).allowed).toBe(true);
    }
    expect((await registerFailure(bucket)).allowed).toBe(false);
  });

  it('releases the lockout once the window has passed', async () => {
    const bucket = adminBucket('198.51.100.7');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(bucket);
    expect((await checkRateLimit(bucket)).allowed).toBe(false);

    // Just past one window.
    await ageFailures(bucket, WINDOW_MS + 1000);
    expect((await checkRateLimit(bucket)).allowed).toBe(true);
  });

  it('a correct code clears the bucket immediately', async () => {
    const bucket = adminBucket('198.51.100.7');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(bucket);
    expect((await checkRateLimit(bucket)).allowed).toBe(false);

    await clearFailures(bucket);
    expect((await checkRateLimit(bucket)).allowed).toBe(true);
  });

  it('reads its numbers from the cascade, not from code', async () => {
    const bucket = adminBucket('198.51.100.7');
    // Raise the threshold; the same failures must now be allowed.
    await seedPolicy(MAX_ATTEMPTS + 5, WINDOW_MIN);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(bucket);

    expect((await checkRateLimit(bucket)).allowed).toBe(true);
  });

  it('fails loudly when the policy is not configured at all', async () => {
    await sql`delete from system_settings where key like 'auth.%'`;
    await expect(checkRateLimit(adminBucket('198.51.100.7'))).rejects.toThrow(
      /auth\.admin_max_attempts/,
    );
  });
});

describe('clientIp', () => {
  it('never trusts x-forwarded-for, which any caller can send', () => {
    // The bypass an independent QA pass demonstrated: rotate this header and a
    // 5-attempt policy yields an unlimited supply of fresh buckets. Honouring it
    // makes the lockout unreachable, so it must not contribute to the bucket.
    const spoofed = new Headers({ 'x-forwarded-for': '198.51.100.7' });
    expect(clientIp(spoofed)).toBe('unknown');

    const alsoSpoofed = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIp(alsoSpoofed)).toBe(clientIp(spoofed));
  });

  it('uses the platform header, which the caller cannot forge', () => {
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '198.51.100.7' }))).toBe(
      '198.51.100.7',
    );
  });

  it('prefers the platform header over anything the caller supplied', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '198.51.100.7',
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '192.0.2.1',
    });
    expect(clientIp(headers)).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('takes the first entry when the platform appended to an inbound value', () => {
    const headers = new Headers({ 'x-vercel-forwarded-for': '198.51.100.7, 10.0.0.1' });
    expect(clientIp(headers)).toBe('198.51.100.7');
  });

  it('buckets everyone together rather than failing open', () => {
    // No trusted header at all: one shared bucket throttles every caller, which
    // is the safe direction for a login route.
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
