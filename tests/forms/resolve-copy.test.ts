import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json, setSystemSetting } from '../helpers/fixtures';
import { resolveFormCopy } from '@/lib/forms/resolve-copy';
import { interpolateCopy, UNSET_PLACEHOLDER } from '@/lib/forms/copy';

/**
 * Copy tokens resolve through the cascade, never off a column
 * (spec/README.md §2.2, `CLAUDE.md`).
 *
 * Against the real `resolve_setting()` rather than a stub, because the point of
 * this module is that it reads the same walk `claim_seats()` reads. A stubbed
 * cascade would prove only that the stub agrees with itself.
 */

const TZ = 'Asia/Singapore';

async function setSegmentPartyCap(segmentId: number, cap: number | null): Promise<void> {
  await sql`update show_segments set max_tickets_per_response = ${cap} where id = ${segmentId}`;
}

async function setConcertDefault(concertId: number, key: string, value: unknown): Promise<void> {
  await sql`
    update concerts set defaults = coalesce(defaults, '{}'::jsonb) || ${json({ [key]: value })}::text::jsonb
    where id = ${concertId}
  `;
}

describe('resolveFormCopy', () => {
  beforeEach(resetDb);

  it('resolves nothing when nothing is configured — the system is configured with nothing', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: null });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });

    expect(values).toEqual({});
    // And the copy says so, rather than inventing a figure.
    expect(interpolateCopy('You have **{{base_quota}}** seats.', values).text).toBe(
      `You have **${UNSET_PLACEHOLDER}** seats.`,
    );
  });

  it('reads base_quota from the segment', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: 2,
    });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.base_quota).toBe('2');
  });

  it('falls back to the concert when the segment does not override', async () => {
    const concertId = await createConcert();
    await setConcertDefault(concertId, 'allocation.base_quota', 4);
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: null,
    });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.base_quota).toBe('4');
  });

  it('lets the segment win over the concert', async () => {
    const concertId = await createConcert();
    await setConcertDefault(concertId, 'allocation.base_quota', 4);
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: 2,
    });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.base_quota).toBe('2');
  });

  it('derives max_additional_guests as the party cap less the registrant (decision 36)', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
    await setSegmentPartyCap(segmentId, 4);

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });

    // The cap is total party size. The repeater renders three rows, so the copy
    // above it has to say three too.
    expect(values.max_tickets_per_response).toBe('4');
    expect(values.max_additional_guests).toBe('3');
  });

  it('never derives a negative number of guests from a cap of one', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
    await setSegmentPartyCap(segmentId, 1);

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.max_additional_guests).toBe('0');
  });

  it('leaves max_additional_guests unresolved when the cap is unset, rather than saying zero', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.max_additional_guests).toBeUndefined();
  });

  it('renders the claim deadline as a date in the concert timezone', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    // 19:30 UTC on 19 Sep is 03:30 on the 20th in Singapore — the whole point of
    // rendering in the concert's zone rather than the reader's.
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseClaimDeadline: new Date('2026-09-19T19:30:00Z'),
    });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.base_claim_deadline).toBe('Sun 20 Sep 2026');

    const utc = await resolveFormCopy({ segmentId, showId, concertId, timeZone: 'UTC' });
    expect(utc.base_claim_deadline).toBe('Sat 19 Sep 2026');
  });

  it('drops the deadline rather than guessing when the timezone is unknown', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseClaimDeadline: new Date('2026-09-19T19:30:00Z'),
    });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: null });
    expect(values.base_claim_deadline).toBeUndefined();
  });

  it('reads extra_rows_max from the system level when nothing overrides it', async () => {
    await setSystemSetting('form.extra_rows_max', 4);
    const concertId = await createConcert();
    const showId = await createShow(concertId, null);
    const segmentId = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: null });

    const values = await resolveFormCopy({ segmentId, showId, concertId, timeZone: TZ });
    expect(values.extra_rows_max).toBe('4');
  });
});
