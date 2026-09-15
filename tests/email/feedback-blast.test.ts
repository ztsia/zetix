import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../helpers/fixtures';
import { nextSendTime, queueFeedbackBlast } from '@/lib/email/feedback-blast';

/**
 * The post-show feedback blast (spec/v2.md §13.5.1, §13.5.2).
 *
 * Three claims are load-bearing and each is proved here rather than argued:
 *
 * 1. **Admitted only, computed now.** The audience is attendees with a live
 *    `check_ins` row, built at send time — never frozen at completion time,
 *    because an usher's phone can drain the next morning.
 * 2. **One email per registration, one link per admitted attendee** (decision 22).
 * 3. **Queued `QUEUED`, not `DRAFT`** (decision 38), due at the send hour — and
 *    idempotent, since this branch re-opens `outbox_no_duplicate_pending`.
 */

const TEMPLATE = 'feedback_request';

let concertId: number;
let showId: number;
let segmentId: number;

async function seedTemplate() {
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Feedback', 'How was {{ show.name }}?',
            'Hello {{ registration.contact_name }}.\n\n{{ feedback_links }}')
    on conflict (key) do update set subject = excluded.subject
  `;
}

async function setSetting(key: string, value: unknown) {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** A party of `count` seats; returns their attendee ids in order. */
async function party(count: number, contactName: string): Promise<number[]> {
  const registrationId = await createRegistration({ showId, segmentId, contactName });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
  const rows = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} order by id
  `;
  return rows.map((r) => Number(r.id));
}

const admit = (attendeeId: number, revertedAt: string | null = null) => sql`
  insert into check_ins (attendee_id, show_id, scanned_at, source, reverted_at)
  values (${attendeeId}, ${showId}, now(), 'ONLINE', ${revertedAt})
`;

const outbox = () => sql<{
  registration_id: string;
  status: string;
  body_md: string;
  scheduled_for: string | null;
  to_email: string;
}[]>`
  select registration_id, status, body_md, scheduled_for, to_email
    from email_outbox where template_key = ${TEMPLATE} order by id
`;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  await seedTemplate();
  await setSetting('portal.feedback_send_hour', 12);

  concertId = await createConcert('Feedback blast');
  showId = await createShow(concertId, 400);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}`;
});

describe('admitted only', () => {
  it('emails a party where somebody came, and not one where nobody did', async () => {
    const came = await party(2, 'Came');
    await party(2, 'Stayed home');
    await issueTickets(concertId, showId);
    await admit(came[0]);

    const result = await queueFeedbackBlast({ showId });
    expect(result.queued).toBe(1);

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    /**
     * By registration, not by address: the fixture gives every party the same
     * contact email, which is itself the point — the dedup key is the
     * registration (decision 22), never the address.
     */
    const [expected] = await sql<{ id: string }[]>`
      select registration_id as id from attendees where id = ${came[0]}
    `;
    expect(rows[0].registration_id).toBe(expected.id);
  });

  it('carries one link per admitted seat, and not the no-show s', async () => {
    /**
     * Decision 22's shape: a party of three where two were admitted gets one
     * email with two links. The third person's link is simply not in it.
     */
    const seats = await party(3, 'Mixed party');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await admit(seats[1]);

    await queueFeedbackBlast({ showId });

    const tokens = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = any(${seats}) order by id
    `;
    const [rows] = await outbox();
    expect(rows.body_md).toContain(tokens[0].qr_token);
    expect(rows.body_md).toContain(tokens[1].qr_token);
    expect(rows.body_md).not.toContain(tokens[2].qr_token);
  });

  it('counts a manual admit and an override, because those people were in the hall', async () => {
    const seats = await party(1, 'Manual admit');
    await issueTickets(concertId, showId);
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${seats[0]}, ${showId}, now(), 'MANUAL')
    `;
    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);
  });

  it('does not count a reverted admission', async () => {
    /**
     * `check_ins` is append-only and a revert stamps `reverted_at` (decision 7).
     * An admin who undid a mis-scan must not have emailed that person about an
     * evening they never attended.
     */
    const seats = await party(1, 'Reverted');
    await issueTickets(concertId, showId);
    await admit(seats[0], new Date().toISOString());
    expect((await queueFeedbackBlast({ showId })).queued).toBe(0);
  });

  it('reaches a late-drained seat inside a party that was already queued', async () => {
    /**
     * **The case an earlier version of this file got wrong**, and the one
     * §13.5.1 actually describes: not a party where nobody was scanned, but a
     * party where *some* were. Two of three scanned live, the third sitting on
     * an usher's phone that drains the next morning — before the send hour, so
     * the message has not gone.
     *
     * A registration-level "already emailed?" check passes every test that uses
     * two separate parties and fails this one silently, which is why it is
     * here. The pending row is rewritten so the party gets **one** message
     * naming all three.
     */
    const seats = await party(3, 'Mixed Drain');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await admit(seats[1]);

    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);

    await admit(seats[2]);
    const second = await queueFeedbackBlast({ showId });
    expect(second.queued).toBe(0);
    expect(second.requeued).toBe(1);

    const tokens = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = any(${seats}) order by id
    `;
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    for (const t of tokens) expect(rows[0].body_md).toContain(t.qr_token);
  });

  it('reaches a late-drained seat after the party s message has gone', async () => {
    /**
     * The same drain, arriving after the send hour. The first message cannot be
     * unsent, so the missed person gets their own — carrying **only** their
     * link, not a duplicate of what the others already received.
     */
    const seats = await party(3, 'Late After Send');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await admit(seats[1]);
    await queueFeedbackBlast({ showId });
    await sql`update email_outbox set status = 'SENT' where template_key = ${TEMPLATE}`;

    await admit(seats[2]);
    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);

    const tokens = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = any(${seats}) order by id
    `;
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    const fresh = rows[1];
    expect(fresh.body_md).toContain(tokens[2].qr_token);
    expect(fresh.body_md).not.toContain(tokens[0].qr_token);
    expect(fresh.body_md).not.toContain(tokens[1].qr_token);
  });

  it('picks up a late-draining phone on a second run', async () => {
    /**
     * §13.5.1's whole argument for computing the list at send time: the usher's
     * device that stayed offline all evening. A frozen audience would omit these
     * people permanently and nothing would reveal it.
     */
    const early = await party(1, 'Scanned live');
    const late = await party(1, 'Scanned offline');
    await issueTickets(concertId, showId);

    await admit(early[0]);
    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);

    await admit(late[0]);
    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);
    expect(await outbox()).toHaveLength(2);
  });

  it('does not email another show s audience', async () => {
    const otherShow = await createShow(concertId, 100);
    const otherSegment = await createSegment(otherShow, {
      audienceMode: 'PUBLIC', capacity: 50,
    });
    const otherReg = await createRegistration({ showId: otherShow, segmentId: otherSegment });
    await seedAttendees({
      registrationId: otherReg, showId: otherShow, segmentId: otherSegment, count: 1,
      allocationType: 'BASE',
    });
    await issueTickets(concertId, otherShow);
    const [other] = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${otherReg}
    `;
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${Number(other.id)}, ${otherShow}, now(), 'ONLINE')
    `;

    expect((await queueFeedbackBlast({ showId })).queued).toBe(0);
  });
});

describe('decision 38 — queued, not drafted', () => {
  it('lands QUEUED so no human gate stands between it and the send hour', async () => {
    const seats = await party(1, 'Queued');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await queueFeedbackBlast({ showId });

    const [row] = await outbox();
    expect(row.status).toBe('QUEUED');
  });

  it('is due at the next send hour, never immediately', async () => {
    /**
     * The gap is the review window decision 38 traded the DRAFT gate for, and
     * it is also what stops anyone being emailed at 10:30pm. A null
     * `scheduled_for` reads as "due now" to the dispatcher, so it is the exact
     * failure this asserts against.
     */
    const seats = await party(1, 'Scheduled');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await queueFeedbackBlast({ showId });

    const [row] = await outbox();
    expect(row.scheduled_for).not.toBeNull();
    expect(new Date(row.scheduled_for!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the send hour, in the concert s zone', () => {
  const KL = 'Asia/Kuala_Lumpur';

  it('picks today s hour when it is still ahead', async () => {
    /** 03:00Z is 11am in KL (UTC+8), so noon today is still to come. */
    const now = new Date('2026-09-20T03:00:00Z');
    expect(nextSendTime({ hour: 12, timeZone: KL, now }).toISOString()).toBe(
      '2026-09-20T04:00:00.000Z',
    );
  });

  it('rolls to tomorrow once it has passed', async () => {
    /** 14:30Z is 10:30pm in KL — the completion time §13.5.2 has in mind. */
    const now = new Date('2026-09-19T14:30:00Z');
    expect(nextSendTime({ hour: 12, timeZone: KL, now }).toISOString()).toBe(
      '2026-09-20T04:00:00.000Z',
    );
  });

  it('never returns a time in the past, even at exactly the send hour', async () => {
    const now = new Date('2026-09-19T04:00:00Z');
    const next = nextSendTime({ hour: 12, timeZone: KL, now });
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('resolves the zone from the concert, not the server', async () => {
    const seats = await party(1, 'Zoned');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await sql`update concerts set timezone = 'Pacific/Auckland' where id = ${concertId}`;
    await queueFeedbackBlast({ showId });

    const [row] = await outbox();
    const hourInNz = new Date(row.scheduled_for!).toLocaleString('en-GB', {
      timeZone: 'Pacific/Auckland',
      hour: '2-digit',
      hour12: false,
    });
    expect(hourInNz).toContain('12');
  });

  it('refuses rather than guessing when the concert has no timezone', async () => {
    /**
     * spec/README.md §2.1. The only fallback available is a null
     * `scheduled_for`, which the dispatcher reads as due now — the 10:30pm email
     * the send hour exists to prevent.
     */
    const seats = await party(1, 'No zone');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await sql`update concerts set timezone = null where id = ${concertId}`;

    await expect(queueFeedbackBlast({ showId })).rejects.toThrow(/concert.timezone/);
    expect(await outbox()).toHaveLength(0);
  });
});

describe('pressing it twice is harmless', () => {
  it('queues nothing the second time while the first is still pending', async () => {
    /** `outbox_no_duplicate_pending`, the index this branch re-opens. */
    const a = await party(2, 'One');
    const b = await party(1, 'Two');
    await issueTickets(concertId, showId);
    await admit(a[0]);
    await admit(b[0]);

    expect((await queueFeedbackBlast({ showId })).queued).toBe(2);
    expect((await queueFeedbackBlast({ showId })).queued).toBe(0);
    expect(await outbox()).toHaveLength(2);
  });

  it('queues nothing a week later, once the first batch has sent', async () => {
    /**
     * The pending index alone is no protection here — a `SENT` row conflicts
     * with nothing. This is the feedback analogue of `attendees.ticket_sent_at`,
     * and without it **Generate feedback emails** would mail everyone again.
     */
    const seats = await party(1, 'Sent already');
    await issueTickets(concertId, showId);
    await admit(seats[0]);

    await queueFeedbackBlast({ showId });
    await sql`update email_outbox set status = 'SENT' where template_key = ${TEMPLATE}`;

    const again = await queueFeedbackBlast({ showId });
    expect(again.queued).toBe(0);
    expect(again.alreadySent).toBe(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('re-queues a FAILED row, which was never delivered', async () => {
    const seats = await party(1, 'Failed');
    await issueTickets(concertId, showId);
    await admit(seats[0]);

    await queueFeedbackBlast({ showId });
    await sql`update email_outbox set status = 'FAILED' where template_key = ${TEMPLATE}`;

    expect((await queueFeedbackBlast({ showId })).queued).toBe(1);
  });
});
