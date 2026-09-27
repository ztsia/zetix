import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { dispatchBatch } from '@/lib/email/dispatch';
import type { MailTransport, OutgoingMessage } from '@/lib/mail/transport';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import type { AudienceFilter } from '@/lib/audience/filter';

/**
 * Delivery — spec/v3.md §24.1–§24.3, §23.2: Send tickets, Resend, Mark
 * delivered by hand, Cancel sending.
 *
 * Written before the commands. Each runs through the real runner, the way the
 * wizard runs it, and asserts what a guest would notice: which parties get a
 * message, worded how, carrying which tickets — and that pressing Send twice
 * leaves exactly one message to go out.
 */

let concertId: number;
let showId: number;
let publicSeg: number;
let playerSeg: number;
let designId: number;

const far = () => Date.now() + 60_000;

async function run(name: string, selection: unknown, params: unknown = {}) {
  const def = getCommand(name);
  if (!def) throw new Error(`no command ${name}`);
  return startCommand(def, { concertId, selection, params }, { actorId: null, deadline: far() });
}

async function preview(name: string, selection: unknown, params: unknown = {}) {
  return previewCommand(getCommand(name)!, { concertId, selection, params }, null);
}

const byFilter = (filter: AudienceFilter) => ({ filter, excludedIds: [] });

const seats = (n: number, name = 'Guest'): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: 'EXTRA' }));

async function party(segmentId: number, n: number, name = 'Party', email: string | null = 'party@example.test') {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: name,
    contactEmail: email,
    seats: seats(n, name),
  });
  return registrationId;
}

async function stage(id: number) {
  const [row] = await sql<{ stage: string | null; flags: string[] }[]>`
    select stage, flags from party_pipeline where registration_id = ${id}`;
  return row;
}

async function messages(id: number) {
  return sql<{
    id: string;
    status: string;
    purpose: string;
    template_key: string;
    to_email: string;
    subject: string;
    body_md: string;
    superseded_by_id: string | null;
    deleted_at: Date | null;
  }[]>`
    select id, status, purpose, template_key, to_email, subject, body_md, superseded_by_id, deleted_at
      from email_outbox where registration_id = ${id} order by id`;
}

const pending = async (id: number) =>
  (await messages(id)).filter((m) => ['DRAFT', 'QUEUED', 'SENDING'].includes(m.status));

function transport(): MailTransport & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { accepted: [message.to], rejected: [], response: '250 ok', messageId: '<t>', raw: null };
    },
    async close() {},
  };
}

const skipReason = (report: Awaited<ReturnType<typeof run>>, id: number) =>
  JSON.stringify(report.items.find((i) => i.entityId === id)?.outcome ?? null);

beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates();
  concertId = await createConcert('Delivery');
  showId = await createShow(concertId, 100);
  publicSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 40, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Public' });
  playerSeg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 40, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Players' });
  const [design] = await sql<{ id: string }[]>`
    insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concertId}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)
    returning id`;
  designId = Number(design.id);
  await setSystemSetting('admin.typed_confirm_above', 20);
  for (const [key, value] of Object.entries({
    'email.max_per_dispatch': 25,
    'email.max_per_day': 450,
    'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3,
    'email.merge_attachments_above': 8,
    'email.max_attachment_mb': 20,
  })) {
    await setSystemSetting(key, value);
  }
});

describe('Send tickets (§24.1)', () => {
  it('issues what is unissued and queues one message per party, worded for its audience', async () => {
    const pub = await party(publicSeg, 2, 'Pub');
    const ply = await party(playerSeg, 3, 'Ply');

    const report = await run('delivery.send_tickets', { ids: [pub, ply] });
    expect(report.done).toBe(2);

    const [pubMsg] = await messages(pub);
    const [plyMsg] = await messages(ply);
    expect(pubMsg).toMatchObject({ status: 'QUEUED', purpose: 'TICKETS', template_key: 'public_ticket' });
    expect(plyMsg).toMatchObject({ status: 'QUEUED', purpose: 'TICKETS', template_key: 'player_confirmation' });
    // Rendered after issuing, so every seat's link is in it.
    expect(plyMsg.body_md.match(/\/t\/[0-9A-Za-z]{22}/g)).toHaveLength(3);
    expect((await stage(pub)).stage).toBe('READY_TO_SEND');

    const [pinned] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where registration_id in (${pub}, ${ply}) and ticket_template_id = ${designId} and qr_token is not null`;
    expect(pinned.n).toBe(5);
  });

  it('pressed twice leaves one message to send, and the dispatcher delivers every ticket once', async () => {
    const a = await party(publicSeg, 2, 'A');
    const b = await party(publicSeg, 1, 'B');
    const c = await party(publicSeg, 3, 'C');

    await run('delivery.send_tickets', byFilter({ view: 'needs-tickets' }));
    const second = await run('delivery.send_tickets', { ids: [a, b, c] });
    expect(second.done).toBe(0);
    expect(skipReason(second, a)).toContain('already waiting');

    for (const id of [a, b, c]) expect(await pending(id)).toHaveLength(1);

    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent).toHaveLength(3);
    for (const id of [a, b, c]) expect((await stage(id)).stage).toBe('SENT');

    // Everything is delivered now: a third press has nothing left to do.
    const third = await run('delivery.send_tickets', { ids: [a, b, c] });
    expect(third.done).toBe(0);
    expect(skipReason(third, a)).toContain('Resend');
  });

  it('skips every party it must not send to, each with its reason', async () => {
    const unapproved = await party(publicSeg, 1, 'Unapproved');
    await sql`update registrations set approved_at = null where id = ${unapproved}`;
    const unverified = await party(publicSeg, 1, 'Unverified');
    await sql`update registrations set verification_token = 'tok-unverified' where id = ${unverified}`;
    const noAddress = await party(publicSeg, 1, 'Nobody', null);
    const suspicious = await party(publicSeg, 1, 'Typo', 'party@gmail.con');
    await sql`update registrations set email_issue = 'We could not find the mail server', email_checked_at = now()
               where id = ${suspicious}`;
    const waitlisted = await party(publicSeg, 1, 'Waiting');
    await sql`update attendees set status = 'WAITLIST' where registration_id = ${waitlisted}`;
    await sql`update registrations set status = 'WAITLIST' where id = ${waitlisted}`;
    const fine = await party(publicSeg, 1, 'Fine');

    const ids = [unapproved, unverified, noAddress, suspicious, waitlisted, fine];
    const p = await preview('delivery.send_tickets', { ids });
    expect(p.runnable).toBe(1);
    const reasons = Object.fromEntries(p.rows.map((r) => [r.id, r.skip]));
    expect(reasons[unapproved]).toMatch(/approved/i);
    expect(reasons[unverified]).toMatch(/verif/i);
    expect(reasons[noAddress]).toMatch(/no email address/i);
    expect(reasons[suspicious]).toMatch(/mail server/i);
    expect(reasons[waitlisted]).toMatch(/waitlist/i);
    expect(reasons[fine]).toBeNull();

    // Accepting the address is the way past the check (§24.6).
    await sql`update registrations set email_issue_accepted_at = now() where id = ${suspicious}`;
    expect((await preview('delivery.send_tickets', { ids: [suspicious] })).runnable).toBe(1);
  });

  it('says in the preview how many tickets it will issue first', async () => {
    await party(publicSeg, 2);
    await party(publicSeg, 3);
    const p = await preview('delivery.send_tickets', byFilter({}));
    expect(p.blastRadius.map((l) => [l.count, l.text]).join('\n')).toMatch(/5,.*issued/);
  });

  it('pins a design chosen for the segment, and uses this send’s wording without touching the template', async () => {
    const [other] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Gala', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', false)
      returning id`;
    const id = await party(publicSeg, 2);

    await run('delivery.send_tickets', { ids: [id] }, {
      designs: { [publicSeg]: Number(other.id) },
      wording: { public_ticket: { subject: 'Just for {{ show.name }}', bodyMd: 'Hi {{ registration.contact_name }}' } },
    });

    const designs = await sql<{ ticket_template_id: string }[]>`
      select ticket_template_id from attendees where registration_id = ${id}`;
    expect(designs.every((d) => Number(d.ticket_template_id) === Number(other.id))).toBe(true);
    const [msg] = await messages(id);
    expect(msg.subject).toMatch(/^Just for /);
    expect(msg.body_md).toBe('Hi Party');
    const [library] = await sql<{ subject: string }[]>`select subject from email_templates where key = 'public_ticket'`;
    expect(library.subject).not.toMatch(/^Just for/);
  });

  it('uses the segment’s stored default template, and supersedes a pending draft worded otherwise', async () => {
    await sql`insert into segment_message_defaults (segment_id, purpose, template_key)
              values (${publicSeg}, 'TICKETS', 'player_confirmation')`;
    const id = await party(publicSeg, 1);
    await run('delivery.send_tickets', { ids: [id] });
    const [first] = await messages(id);
    expect(first.template_key).toBe('player_confirmation');

    // Switching template for this send replaces the queued one; it never sends both.
    await run('delivery.send_tickets', { ids: [id] }, { templates: { [publicSeg]: 'public_ticket' } });
    const [old, current] = await messages(id);
    expect(old).toMatchObject({ status: 'CANCELLED', superseded_by_id: current.id });
    expect(current).toMatchObject({ status: 'QUEUED', template_key: 'public_ticket' });
  });

  it('refuses a template that does not carry tickets', async () => {
    const id = await party(publicSeg, 1);
    const report = await run('delivery.send_tickets', { ids: [id] }, { templates: { [publicSeg]: 'reminder' } });
    expect(report.done).toBe(0);
    expect(await messages(id)).toHaveLength(0);
  });
});

describe('Resend', () => {
  it('sends a delivered party every ticket again, to its current address', async () => {
    const id = await party(publicSeg, 2);
    await run('delivery.send_tickets', { ids: [id] });
    await dispatchBatch({ transport: transport() });
    await sql`update registrations set contact_email = 'new@example.test' where id = ${id}`;

    const report = await run('delivery.resend', { ids: [id] });
    expect(report.done).toBe(1);
    const latest = (await messages(id)).at(-1)!;
    expect(latest).toMatchObject({ status: 'QUEUED', to_email: 'new@example.test' });
    expect(latest.body_md.match(/\/t\//g)).toHaveLength(2);
  });
});

describe('Mark delivered by hand', () => {
  it('marks issued seats delivered, withdraws the pending email, and sends nothing', async () => {
    const id = await party(publicSeg, 2);
    await run('delivery.send_tickets', { ids: [id] });

    const report = await run('delivery.mark_delivered', { ids: [id] });
    expect(report.done).toBe(1);
    expect((await stage(id)).stage).toBe('SENT');
    const sources = await sql<{ ticket_sent_source: string }[]>`
      select ticket_sent_source from attendees where registration_id = ${id}`;
    expect(sources.every((s) => s.ticket_sent_source === 'MANUAL')).toBe(true);
    expect(await pending(id)).toHaveLength(0);
  });

  it('skips a party with no issued ticket', async () => {
    const id = await party(publicSeg, 1);
    const p = await preview('delivery.mark_delivered', { ids: [id] });
    expect(p.rows[0].skip).toMatch(/issued/i);
  });
});

describe('Cancel sending', () => {
  it('withdraws what is waiting, and a re-run finds nothing', async () => {
    const id = await party(publicSeg, 1);
    await run('delivery.send_tickets', { ids: [id] });
    expect((await run('delivery.cancel_sending', { ids: [id] })).done).toBe(1);
    expect(await pending(id)).toHaveLength(0);
    expect((await run('delivery.cancel_sending', { ids: [id] })).done).toBe(0);

    // Nothing left in the queue, so nothing goes out.
    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent).toHaveLength(0);
  });
});

/**
 * tickets.md §10.5 (non-negotiable): a ticket someone holds never changes
 * silently. A design chosen in the wizard repins only seats not yet delivered;
 * a delivered seat keeps the version it was sent with, on Send and on Resend.
 */
describe('a design chosen for one send never repins a delivered ticket', () => {
  async function pins(id: number) {
    return (
      await sql<{ ticket_template_id: string; delivered: boolean; qr_token: string }[]>`
        select ticket_template_id, ticket_sent_at is not null as delivered, qr_token
          from attendees where registration_id = ${id} order by id`
    ).map((r) => ({ design: Number(r.ticket_template_id), delivered: r.delivered, token: r.qr_token }));
  }

  it('on Send tickets to a party with a guest added since, and on Resend', async () => {
    const [gala] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Gala', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', false)
      returning id`;
    const galaId = Number(gala.id);
    const id = await party(publicSeg, 2);
    await run('delivery.send_tickets', { ids: [id] });
    await dispatchBatch({ transport: transport() });
    const delivered = await pins(id);

    await sql`select claim_seats(${publicSeg}::bigint, ${id}::bigint,
                ${JSON.stringify([{ full_name: 'Late guest', allocation_type: 'EXTRA' }])}::text::jsonb, false)`;
    await run('delivery.send_tickets', { ids: [id] }, { designs: { [publicSeg]: galaId } });
    const afterSend = await pins(id);
    expect(afterSend.map((s) => s.design)).toEqual([designId, designId, galaId]);
    expect(afterSend.slice(0, 2).map((s) => s.token)).toEqual(delivered.map((s) => s.token));

    await dispatchBatch({ transport: transport() });
    await run('delivery.resend', { ids: [id] }, { designs: { [publicSeg]: galaId } });
    expect((await pins(id)).map((s) => s.design)).toEqual([designId, designId, galaId]);
  });
});

describe('a waiting granted-extras email (§24.2)', () => {
  it('is superseded by Send tickets, so the party gets its tickets once', async () => {
    const id = await party(publicSeg, 2);
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, context)
              values (${id}, 'EXTRAS_DECISION', 'extras_granted', 'party@example.test', 'Granted', 'b', 'QUEUED',
                      '{"attendee_count":"2"}')`;
    const p = await preview('delivery.send_tickets', { ids: [id] });
    expect(p.rows[0].detail).toMatch(/Replaces/);

    await run('delivery.send_tickets', { ids: [id] });
    const rows = await messages(id);
    expect(rows.map((m) => [m.template_key, m.status])).toEqual([
      ['extras_granted', 'CANCELLED'],
      ['public_ticket', 'QUEUED'],
    ]);
    expect(rows[0].superseded_by_id).toBe(rows[1].id);

    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent).toHaveLength(1);
  });
});
