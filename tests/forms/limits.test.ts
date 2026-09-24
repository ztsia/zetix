import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { resolveRepeaterLimits } from '@/lib/forms/limits';
import { PLAYER_FORM, PUBLIC_FORM, FEEDBACK_FORM } from './fixtures';

/**
 * Repeater row caps, resolved through the cascade (spec/v2.md §8.3).
 *
 * The interesting cases are the two that are not a straight read: the party cap
 * is total party size and the registrant is seat #1 (decision 36), and base
 * seats are what a player has **left**, not what they were granted (§8.1.1).
 */

async function setSegmentPartyCap(segmentId: number, cap: number): Promise<void> {
  await sql`update show_segments set max_tickets_per_response = ${cap} where id = ${segmentId}`;
}

async function publicSegment(cap: number | null) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, null);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
  if (cap !== null) await setSegmentPartyCap(segmentId, cap);
  return { concertId, showId, segmentId };
}

async function playerSegment(baseQuota: number | null) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, null);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: null,
    baseQuota,
  });
  return { concertId, showId, segmentId };
}

describe('resolveRepeaterLimits', () => {
  beforeEach(resetDb);

  it('renders the party cap less the registrant (decision 36)', async () => {
    const ctx = await publicSegment(4);
    const result = await resolveRepeaterLimits(PUBLIC_FORM, ctx);
    expect(result).toEqual({ ok: true, limits: { party: 3 } });
  });

  it('a party cap of one leaves no guest rows, and does not go negative', async () => {
    const ctx = await publicSegment(1);
    const result = await resolveRepeaterLimits(PUBLIC_FORM, ctx);
    expect(result).toEqual({ ok: true, limits: { party: 0 } });
  });

  it('refuses to guess when the cap is not configured', async () => {
    const ctx = await publicSegment(null);
    const result = await resolveRepeaterLimits(PUBLIC_FORM, ctx);
    expect(result).toEqual({ ok: false, missing: ['form.max_tickets_per_response'] });
  });

  it('names every unset key at once, so the admin fixes them in one pass', async () => {
    const ctx = await playerSegment(null);
    const result = await resolveRepeaterLimits(PLAYER_FORM, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing.sort()).toEqual(['allocation.base_quota', 'form.extra_rows_max']);
  });

  it('renders base seats as what is left, not as the quota (§8.1.1)', async () => {
    await setSystemSetting('form.extra_rows_max', 4);
    const ctx = await playerSegment(2);

    const fresh = await resolveRepeaterLimits(PLAYER_FORM, ctx);
    expect(fresh).toEqual({ ok: true, limits: { base: 2, extras: 4 } });

    // A player back for round 2, already holding one of their two seats.
    const returning = await resolveRepeaterLimits(PLAYER_FORM, { ...ctx, baseAlreadyClaimed: 1 });
    expect(returning).toEqual({ ok: true, limits: { base: 1, extras: 4 } });
  });

  it('clamps at zero when a player already holds more than their quota', async () => {
    await setSystemSetting('form.extra_rows_max', 4);
    const ctx = await playerSegment(2);
    // An admin grant, or a quota lowered afterwards. The block is unusable, not
    // negative.
    const result = await resolveRepeaterLimits(PLAYER_FORM, { ...ctx, baseAlreadyClaimed: 5 });
    expect(result).toEqual({ ok: true, limits: { base: 0, extras: 4 } });
  });

  it('a feedback form has no repeaters and so needs no configuration at all', async () => {
    const ctx = await publicSegment(null);
    expect(await resolveRepeaterLimits(FEEDBACK_FORM, ctx)).toEqual({ ok: true, limits: {} });
  });
});
