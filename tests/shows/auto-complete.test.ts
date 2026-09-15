import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Show auto-completion on the daily sweep (spec/v2.md §13.5.2, §13.5.3).
 *
 * **What is being proved is that it is inert wherever it should be.** It moves
 * `OPEN` → `COMPLETED` and nothing else: not `DRAFT`, not `CLOSED`, never
 * backwards, never on a show with no end time, and never twice. The one thing it
 * does beyond the flag — queue the feedback email — is covered in
 * `tests/email/feedback-blast.test.ts`; here it is only asserted that a second
 * run does not queue a second time.
 */

vi.mock('@/lib/auth/session', () => ({ getSessionUser: async () => null }));

const { autoCompleteShows } = await import('@/lib/shows/complete');

let concertId: number;

async function setSetting(key: string, value: unknown) {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** A show that ended `hoursAgo` ago, in the given status. */
async function showEndedHoursAgo(hoursAgo: number | null, status = 'OPEN'): Promise<number> {
  const showId = await createShow(concertId, 100);
  await sql`
    update shows
       set status = ${status},
           ends_at = ${hoursAgo === null ? null : sql`now() - (${hoursAgo}::numeric * interval '1 hour')`}
     where id = ${showId}
  `;
  return showId;
}

const statusOf = async (showId: number) => {
  const [row] = await sql<{ status: string }[]>`select status from shows where id = ${showId}`;
  return row.status;
};

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Sweep');
  await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}`;
  await setSetting('show.auto_complete_after_hours', 2);
  await setSetting('portal.feedback_send_hour', 12);
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values ('feedback_request', 'Feedback', 'How was {{ show.name }}?', '{{ feedback_links }}')
    on conflict (key) do nothing
  `;
});

describe('what it completes', () => {
  it('completes an OPEN show whose grace window has passed', async () => {
    const showId = await showEndedHoursAgo(3);
    const outcomes = await autoCompleteShows();

    expect(outcomes.map((o) => o.showId)).toEqual([showId]);
    expect(await statusOf(showId)).toBe('COMPLETED');
  });

  it('leaves a show still inside its grace window alone', async () => {
    const showId = await showEndedHoursAgo(1);
    expect(await autoCompleteShows()).toEqual([]);
    expect(await statusOf(showId)).toBe('OPEN');
  });

  it('leaves a show that has not ended alone', async () => {
    const showId = await showEndedHoursAgo(-3);
    expect(await autoCompleteShows()).toEqual([]);
    expect(await statusOf(showId)).toBe('OPEN');
  });
});

describe('what it never touches', () => {
  it('never completes a DRAFT show', async () => {
    /** A show nobody opened has had no audience. */
    const showId = await showEndedHoursAgo(3, 'DRAFT');
    await autoCompleteShows();
    expect(await statusOf(showId)).toBe('DRAFT');
  });

  it('never completes a CLOSED show', async () => {
    /** `CLOSED` is an admin's deliberate "we are done here". */
    const showId = await showEndedHoursAgo(3, 'CLOSED');
    await autoCompleteShows();
    expect(await statusOf(showId)).toBe('CLOSED');
  });

  it('never completes a show with no end time, however long ago it started', async () => {
    /** Decision 41. Nothing is inferred from `starts_at`. */
    const showId = await showEndedHoursAgo(null);
    await sql`update shows set starts_at = now() - interval '30 days' where id = ${showId}`;
    await autoCompleteShows();
    expect(await statusOf(showId)).toBe('OPEN');
  });

  it('never completes a soft-deleted show', async () => {
    const showId = await showEndedHoursAgo(3);
    await sql`update shows set deleted_at = now() where id = ${showId}`;
    expect(await autoCompleteShows()).toEqual([]);
  });

  it('never reopens anything', async () => {
    const showId = await showEndedHoursAgo(3, 'COMPLETED');
    await autoCompleteShows();
    expect(await statusOf(showId)).toBe('COMPLETED');
  });
});

describe('it is idempotent', () => {
  it('completes on one run and does nothing on the next', async () => {
    const showId = await showEndedHoursAgo(3);
    expect((await autoCompleteShows()).length).toBe(1);
    expect(await autoCompleteShows()).toEqual([]);
    expect(await statusOf(showId)).toBe('COMPLETED');
  });

  it('does not queue the feedback email twice', async () => {
    const showId = await showEndedHoursAgo(3);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId, showId, segmentId, count: 1, allocationType: 'BASE',
    });
    await issueTickets(concertId, showId);
    const [attendee] = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationId}
    `;
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${Number(attendee.id)}, ${showId}, now(), 'ONLINE')
    `;

    const first = await autoCompleteShows();
    expect(first[0].queued).toBe(1);

    await autoCompleteShows();

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where template_key = 'feedback_request'
    `;
    expect(rows[0].n).toBe(1);
  });
});

describe('one show s configuration problem does not stop the sweep', () => {
  it('still completes the others when a concert has no timezone', async () => {
    /**
     * A concert with no timezone has no "noon" to send at, and that is a real
     * refusal (spec/README.md §2.1). But it is one show's problem: letting it
     * abort the sweep would leave every later show uncompleted and blame the
     * cron.
     */
    const broken = await createConcert('No zone');
    await sql`update concerts set timezone = null where id = ${broken}`;
    const brokenShow = await createShow(broken, 100);
    await sql`update shows set status = 'OPEN', ends_at = now() - interval '3 hours'
               where id = ${brokenShow}`;

    const healthyShow = await showEndedHoursAgo(3);

    const outcomes = await autoCompleteShows();
    expect(outcomes).toHaveLength(2);
    expect(await statusOf(healthyShow)).toBe('COMPLETED');

    /**
     * The flag still moved for the broken one — the show *is* over — and the
     * error names the setting so **Generate feedback emails** can finish the job
     * once someone sets the timezone (decision 42).
     */
    expect(await statusOf(brokenShow)).toBe('COMPLETED');
    const broken_ = outcomes.find((o) => o.showId === brokenShow);
    expect(broken_?.error).toMatch(/concert.timezone/);
  });
});

describe('it writes an audit row without a session', () => {
  it('records the completion with a null actor', async () => {
    /**
     * The cron has no admin. Resolving the actor from a session would be both
     * wrong and a second connection — and `src/db/client.ts` is `max: 1`, which
     * is how that becomes a deadlock rather than a mistake.
     */
    const showId = await showEndedHoursAgo(3);
    await autoCompleteShows();

    const rows = await sql<{ actor_id: string | null; action: string }[]>`
      select actor_id, action from audit_log where action = 'show.auto_completed'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
    expect(showId).toBeGreaterThan(0);
  });
});
