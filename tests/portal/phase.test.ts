import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { ticketStatus } from '@/lib/portal/status';

/**
 * "The show is over", against the real database (spec/v2.md §13.2.1, decision 40).
 *
 * **The predicate is SQL, so it is tested as SQL.** `SHOW_IS_OVER` resolves
 * `show.auto_complete_after_hours` through the four-level cascade and adds it to
 * `shows.ends_at`; a TypeScript reimplementation in the test would assert the
 * test's arithmetic rather than the database's, and the one failure that matters
 * here — the portal and the auto-completion sweep disagreeing about an evening —
 * is invisible to a test that does not run the same expression they do.
 *
 * Every case drives it through `ticketStatus()`, which is where a guest meets
 * it.
 */

const { issueTickets } = await import('@/lib/tickets/issue');

let concertId: number;
let showId: number;
let token: string;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Phase');
  showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 1, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ qr_token: string }[]>`select qr_token from attendees`;
  token = rows[0].qr_token;
});

/** Seeds the key at the system root, which is where `scripts/seed-settings.ts` puts it. */
async function setAutoCompleteHours(value: number | null): Promise<void> {
  if (value === null) {
    await sql`delete from system_settings where key = 'show.auto_complete_after_hours'`;
    return;
  }
  await sql`
    insert into system_settings (key, value)
    values ('show.auto_complete_after_hours', ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** `ends_at` relative to now, in hours. Negative is in the past. */
async function setEndsAt(hoursFromNow: number | null): Promise<void> {
  if (hoursFromNow === null) {
    await sql`update shows set ends_at = null where id = ${showId}`;
    return;
  }
  await sql`
    update shows
       set ends_at = now() + (${hoursFromNow}::numeric * interval '1 hour')
     where id = ${showId}
  `;
}

const isOver = async () => (await ticketStatus(token))!.showIsOver;

describe('the post-show phase comes off the clock', () => {
  beforeEach(async () => {
    await setAutoCompleteHours(2);
  });

  it('is not over while the show has not ended', async () => {
    await setEndsAt(3);
    expect(await isOver()).toBe(false);
  });

  it('is not over inside the grace window', async () => {
    /**
     * Ended an hour ago with a two-hour grace: the concert is out but the
     * evening is not. This is the case the grace window exists for — an
     * audience still in the foyer must not be asked how their evening was.
     */
    await setEndsAt(-1);
    expect(await isOver()).toBe(false);
  });

  it('is over once the grace window has passed', async () => {
    await setEndsAt(-3);
    expect(await isOver()).toBe(true);
  });

  it('flips with no job having run — shows.status is untouched', async () => {
    await setEndsAt(-3);
    expect(await isOver()).toBe(true);

    const [row] = await sql<{ status: string }[]>`
      select status from shows where id = ${showId}
    `;
    /**
     * The whole point of decision 40: a guest opening their link at 11pm gets
     * the post-show portal while the flag is still whatever the admin left it.
     * If this ever reads COMPLETED, something has started writing the phase
     * down and the portal has gone back to waiting for a cron.
     */
    expect(row.status).not.toBe('COMPLETED');
  });
});

describe('a show with no end time has no post-show phase at all', () => {
  /**
   * Decision 41. Nothing is inferred from `starts_at`: a concert with an
   * interval runs long, and a portal that flipped to "how was your evening?"
   * mid-performance is worse than one that waited for a human.
   */
  it('is never over, however long ago it started', async () => {
    await setAutoCompleteHours(2);
    await setEndsAt(null);
    await sql`update shows set starts_at = now() - interval '30 days' where id = ${showId}`;
    expect(await isOver()).toBe(false);
  });
});

describe('an unresolved grace period is not a zero one', () => {
  it('is never over when the setting exists at no level', async () => {
    await setAutoCompleteHours(null);
    await setEndsAt(-240);
    /**
     * Ten days past the end time and still not over. Treating "nobody set it"
     * as zero would be a code default for an operational value
     * (spec/README.md §2.1) — and the value it would invent is the most
     * aggressive one available.
     */
    expect(await isOver()).toBe(false);
  });

  it('is never over when the value is not a number', async () => {
    await sql`
      insert into system_settings (key, value)
      values ('show.auto_complete_after_hours', '"soon"'::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
    await setEndsAt(-240);
    expect(await isOver()).toBe(false);
  });
});

describe('the grace period cascades', () => {
  it('a show overrides the system root', async () => {
    await setAutoCompleteHours(100);
    await setEndsAt(-3);
    expect(await isOver()).toBe(false);

    await sql`
      update shows set defaults = '{"show.auto_complete_after_hours": 2}'::jsonb
       where id = ${showId}
    `;
    expect(await isOver()).toBe(true);
  });

  it('a concert overrides the system root', async () => {
    await setAutoCompleteHours(100);
    await setEndsAt(-3);
    expect(await isOver()).toBe(false);

    await sql`
      update concerts set defaults = '{"show.auto_complete_after_hours": 2}'::jsonb
       where id = ${concertId}
    `;
    expect(await isOver()).toBe(true);
  });

  it('a fractional grace period is honoured rather than truncated', async () => {
    /**
     * `make_interval(hours => ...)` takes an integer and would silently floor
     * 0.5 to 0, calling the evening over the moment the music stopped. The
     * expression multiplies an interval instead, so this is the test that keeps
     * it that way.
     */
    await setAutoCompleteHours(0.5);
    await setEndsAt(-0.25);
    expect(await isOver()).toBe(false);

    await setEndsAt(-0.75);
    expect(await isOver()).toBe(true);
  });
});
