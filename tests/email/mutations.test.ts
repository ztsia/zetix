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
import { queueBlast } from '@/lib/email/queue';
import {
  clearDeliveryForResend,
  confirmBatch,
  discardDrafts,
  editMessage,
  editTemplateAndRerender,
  markDelivered,
  ReasonRequiredError,
} from '@/lib/email/mutations';

/** Every mutation is an admin action, so the actor is passed explicitly —
 *  resolving it inside a transaction would deadlock against the `max: 1` pool
 *  (`src/lib/audit.ts`). */
const ACTOR = null;
const TEMPLATE = 'public_ticket';

async function seedBatch(parties: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Public ticket', 'Tickets for {{ concert.name }}',
            'Dear {{ registration.contact_name }}, {{ attendee_count }} attached.')
  `;
  const registrationIds: number[] = [];
  for (let i = 0; i < parties; i++) {
    const registrationId = await createRegistration({ showId, segmentId, contactName: `Party ${i + 1}` });
    await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
    registrationIds.push(registrationId);
  }
  // A ticket-bearing blast refuses a party with a seat still to issue (§11.4),
  // so an unissued fixture would queue nothing and prove nothing here.
  await issueTickets(concertId, showId);
  await queueBlast({ segmentId, templateKey: TEMPLATE });
  return { concertId, showId, segmentId, registrationIds };
}

const statuses = () =>
  sql<{ status: string }[]>`select status from email_outbox order by id`;

beforeEach(resetDb);

describe('confirming a batch', () => {
  it('moves DRAFT to QUEUED and nothing else', async () => {
    const { segmentId } = await seedBatch(3);

    const result = await confirmBatch({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });

    expect(result.queued).toBe(3);
    expect((await statuses()).map((r) => r.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('records the confirmation in the audit log', async () => {
    const { segmentId } = await seedBatch(1);
    await confirmBatch({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });

    const [row] = await sql<{ action: string }[]>`
      select action from audit_log where action = 'email.batch_confirmed'
    `;
    expect(row).toBeDefined();
  });
});

describe('editing one message', () => {
  it('overwrites that row alone', async () => {
    const { segmentId } = await seedBatch(2);
    const [first] = await sql<{ id: string }[]>`select id from email_outbox order by id limit 1`;

    await editMessage({
      outboxId: Number(first.id),
      subject: 'Step-free access',
      bodyMd: 'There is a ramp at the side door.',
      actorId: ACTOR,
    });

    const rows = await sql<{ subject: string }[]>`select subject from email_outbox order by id`;
    expect(rows[0].subject).toBe('Step-free access');
    expect(rows[1].subject).toBe('Tickets for Test Concert');
    expect(segmentId).toBeGreaterThan(0);
  });

  /**
   * Once a batch is QUEUED the dispatcher owns it; editing underneath would
   * send something other than what was confirmed (§11.5).
   */
  it('refuses a row that has left DRAFT', async () => {
    const { segmentId } = await seedBatch(1);
    await confirmBatch({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });
    const [row] = await sql<{ id: string }[]>`select id from email_outbox`;

    const result = await editMessage({
      outboxId: Number(row.id),
      subject: 'Too late',
      bodyMd: 'x',
      actorId: ACTOR,
    });

    expect(result.updated).toBe(false);
    const [after] = await sql<{ subject: string }[]>`select subject from email_outbox`;
    expect(after.subject).toBe('Tickets for Test Concert');
  });
});

describe('editing the template', () => {
  /** §11.5's normal path: fix the wording once, all the messages update. */
  it('re-renders every message nobody has touched', async () => {
    await seedBatch(3);

    const result = await editTemplateAndRerender({
      templateKey: TEMPLATE,
      subject: 'Your seats for {{ concert.name }}',
      bodyMd: 'Dear {{ registration.contact_name }}, see you there.',
      actorId: ACTOR,
    });

    expect(result.rerendered).toBe(3);
    expect(result.preserved).toBe(0);
    const rows = await sql<{ subject: string; body_md: string }[]>`
      select subject, body_md from email_outbox order by id
    `;
    for (const row of rows) {
      expect(row.subject).toBe('Your seats for Test Concert');
      expect(row.body_md).toContain('see you there');
    }
  });

  /**
   * The half that matters: a hand-edited message **survives** a template
   * re-render. Losing that note is how the one person who needed it turns up
   * to a door they cannot use.
   */
  it('leaves a hand-edited message alone', async () => {
    await seedBatch(3);
    const [first] = await sql<{ id: string }[]>`select id from email_outbox order by id limit 1`;
    await editMessage({
      outboxId: Number(first.id),
      subject: 'Step-free access',
      bodyMd: 'There is a ramp at the side door.',
      actorId: ACTOR,
    });

    const result = await editTemplateAndRerender({
      templateKey: TEMPLATE,
      subject: 'Your seats for {{ concert.name }}',
      bodyMd: 'Dear {{ registration.contact_name }}, see you there.',
      actorId: ACTOR,
    });

    expect(result.rerendered).toBe(2);
    expect(result.preserved).toBe(1);
    const rows = await sql<{ subject: string }[]>`select subject from email_outbox order by id`;
    expect(rows[0].subject).toBe('Step-free access');
    expect(rows[1].subject).toBe('Your seats for Test Concert');
  });

  it('stores the new template for the next blast', async () => {
    await seedBatch(1);
    await editTemplateAndRerender({
      templateKey: TEMPLATE,
      subject: 'New subject',
      bodyMd: 'New body',
      actorId: ACTOR,
    });

    const [row] = await sql<{ subject: string }[]>`
      select subject from email_templates where key = ${TEMPLATE}
    `;
    expect(row.subject).toBe('New subject');
  });

  it('does not touch a batch that has already been confirmed', async () => {
    const { segmentId } = await seedBatch(2);
    await confirmBatch({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });

    const result = await editTemplateAndRerender({
      templateKey: TEMPLATE,
      subject: 'Changed',
      bodyMd: 'Changed',
      actorId: ACTOR,
    });

    expect(result.rerendered).toBe(0);
    const rows = await sql<{ subject: string }[]>`select subject from email_outbox`;
    for (const row of rows) expect(row.subject).toBe('Tickets for Test Concert');
  });
});

describe('marking delivered by hand', () => {
  it('stamps MANUAL, sends nothing, and needs a reason', async () => {
    const { registrationIds } = await seedBatch(1);
    const ids = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationIds[0]} order by id
    `;

    const result = await markDelivered({
      attendeeIds: ids.map((r) => Number(r.id)),
      reason: 'Handed over at the rehearsal',
      actorId: ACTOR,
    });

    expect(result.marked).toBe(2);
    const rows = await sql<{ ticket_sent_source: string; ticket_sent_at: string }[]>`
      select ticket_sent_source, ticket_sent_at from attendees
    `;
    for (const row of rows) {
      expect(row.ticket_sent_source).toBe('MANUAL');
      expect(row.ticket_sent_at).not.toBeNull();
    }
    // It sends nothing: the DRAFT it was queued alongside is untouched.
    expect((await statuses()).map((r) => r.status)).toEqual(['DRAFT']);
  });

  it('refuses without a reason, because the audit row would say nothing', async () => {
    const { registrationIds } = await seedBatch(1);
    const ids = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationIds[0]}
    `;

    await expect(
      markDelivered({ attendeeIds: ids.map((r) => Number(r.id)), reason: '   ', actorId: ACTOR }),
    ).rejects.toThrow(ReasonRequiredError);
  });

  /** It is a record of delivery, not a re-delivery: an EMAIL stamp stands. */
  it('does not overwrite a seat already delivered by email', async () => {
    const { registrationIds } = await seedBatch(1);
    await sql`
      update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where registration_id = ${registrationIds[0]}
    `;
    const ids = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationIds[0]}
    `;

    const result = await markDelivered({
      attendeeIds: ids.map((r) => Number(r.id)),
      reason: 'Belt and braces',
      actorId: ACTOR,
    });

    expect(result.marked).toBe(0);
    const rows = await sql<{ ticket_sent_source: string }[]>`
      select ticket_sent_source from attendees
    `;
    for (const row of rows) expect(row.ticket_sent_source).toBe('EMAIL');
  });
});

describe('resend is the exact inverse', () => {
  it('clears the stamp so the next blast selects the party again', async () => {
    const { segmentId, registrationIds } = await seedBatch(1);
    await sql`
      update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where registration_id = ${registrationIds[0]}
    `;
    await sql`update email_outbox set status = 'SENT', sent_at = now()`;
    const ids = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationIds[0]}
    `;

    const result = await clearDeliveryForResend({
      attendeeIds: ids.map((r) => Number(r.id)),
      reason: 'They deleted the email',
      actorId: ACTOR,
    });

    expect(result.cleared).toBe(2);
    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(1);
  });
});

describe('discarding a batch', () => {
  it('withdraws the drafts without sending them', async () => {
    const { segmentId } = await seedBatch(2);

    const result = await discardDrafts({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });

    expect(result.discarded).toBe(2);
    expect((await statuses()).map((r) => r.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  /** A discarded batch no longer blocks the partial unique index, so the admin
   *  can queue a corrected one immediately. */
  it('frees the registration to be queued again', async () => {
    const { segmentId } = await seedBatch(2);
    await discardDrafts({ segmentId, templateKey: TEMPLATE, actorId: ACTOR });

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(2);
  });
});
