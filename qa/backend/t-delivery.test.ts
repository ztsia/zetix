import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../../tests/helpers/fixtures';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { dispatchBatch, outboxBacklog } from '@/lib/email/dispatch';
import type { MailTransport, OutgoingMessage } from '@/lib/email/transport';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import { changeContactEmail } from '@/lib/delivery/address';

/**
 * QA module T, phase 4 — the real database, no mocks. Each `it` names the
 * acceptance criterion it exercises (qa-artifacts/claude-T-send-wizard/01-acceptance.md).
 * Results are printed as `QA <AC> ...` lines so the report can paste them.
 */

let concertId: number;
let showId: number;
let pub: number;
let designA: number;
let designB: number;

const far = () => Date.now() + 60_000;
const log = (...a: unknown[]) => console.log('QA', ...a);

async function run(name: string, selection: unknown, params: unknown = {}, reason: string | null = null, cid = concertId) {
  return startCommand(getCommand(name)!, { concertId: cid, selection, params, reason }, { actorId: null, deadline: far() });
}
const preview = (name: string, selection: unknown, params: unknown = {}) =>
  previewCommand(getCommand(name)!, { concertId, selection, params }, null);

async function party(n: number, name = 'Party', email: string | null = 'party@example.test', seg = pub) {
  const seats: NewSeat[] = Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: 'EXTRA' }));
  return (await createRegistration({ segmentId: seg, contactName: name, contactEmail: email, seats })).registrationId;
}

function transport(): MailTransport & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
      return { accepted: [m.to], rejected: [], response: '250 ok', messageId: `<t${sent.length}>`, raw: null };
    },
    async close() {},
  };
}

const outbox = (rid: number) =>
  sql<{ id: string; status: string; purpose: string; template_key: string; to_email: string; superseded_by_id: string | null }[]>`
    select id, status, purpose, template_key, to_email, superseded_by_id from email_outbox where registration_id = ${rid} order by id`;
const seatsOf = (rid: number) =>
  sql<{ id: string; qr_token: string | null; ticket_template_id: string | null; ticket_template_version: number | null; ticket_sent_at: Date | null; ticket_sent_source: string | null }[]>`
    select id, qr_token, ticket_template_id, ticket_template_version, ticket_sent_at, ticket_sent_source
      from attendees where registration_id = ${rid} order by id`;

async function design(name: string, isDefault: boolean) {
  const [d] = await sql<{ id: string }[]>`
    insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concertId}, ${name}, 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', ${isDefault})
    returning id`;
  return Number(d.id);
}

beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates();
  concertId = await createConcert('T-QA');
  showId = await createShow(concertId, 200);
  pub = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Public' });
  designA = await design('A', true);
  designB = await design('B', false);
  await setSystemSetting('admin.typed_confirm_above', 20);
  for (const [k, v] of Object.entries({
    'email.max_per_dispatch': 25, 'email.max_per_day': 450, 'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3, 'email.merge_attachments_above': 8, 'email.max_attachment_mb': 20,
  })) await setSystemSetting(k, v);
});

describe('T phase 4', () => {
  it('AC-3 preview writes nothing', async () => {
    const ids = [await party(2, 'P1'), await party(3, 'P2')];
    const count = async () => (await sql<{ o: number; t: number; r: number }[]>`
      select (select count(*)::int from email_outbox) o,
             (select count(*)::int from attendees where qr_token is not null) t,
             (select count(*)::int from command_runs) r`)[0];
    const before = await count();
    const p = await preview('delivery.send_tickets', { ids });
    const after = await count();
    log('AC-3', JSON.stringify({ before, after, runnable: p.runnable }));
    expect(after).toEqual(before);
  });

  it('AC-9 a delivered seat keeps its pinned design when a later send picks another', async () => {
    const rid = await party(2, 'Held');
    await run('delivery.send_tickets', { ids: [rid] });
    await dispatchBatch({ transport: transport() });
    const delivered = await seatsOf(rid);
    // an added guest: a third confirmed seat
    await sql`select claim_seats(${pub}::bigint, ${rid}::bigint, ${JSON.stringify([{ full_name: 'Late guest', allocation_type: 'EXTRA' }])}::text::jsonb, false)`;
    const r = await run('delivery.send_tickets', { ids: [rid] }, { designs: { [pub]: designB } });
    const after = await seatsOf(rid);
    log('AC-9/AC-18', JSON.stringify({ report: r.items.map((i) => i.outcome), before: delivered.map((s) => [s.ticket_template_id, !!s.ticket_sent_at]), after: after.map((s) => [s.ticket_template_id, !!s.ticket_sent_at]) }));
    expect(after.slice(0, 2).map((s) => Number(s.ticket_template_id))).toEqual([designA, designA]);
    expect(Number(after[2].ticket_template_id)).toBe(designB);
    // AC-48: tokens unchanged
    expect(after.slice(0, 2).map((s) => s.qr_token)).toEqual(delivered.map((s) => s.qr_token));
    // AC-18: one message carrying all three
    const mail = transport();
    await dispatchBatch({ transport: mail });
    log('AC-18 sent', mail.sent.length, 'attachments', mail.sent[0]?.attachments?.length);
    expect(mail.sent).toHaveLength(1);
  });

  it('AC-9b Resend with a new design leaves delivered seats pinned', async () => {
    const rid = await party(2, 'Res');
    await run('delivery.send_tickets', { ids: [rid] });
    await dispatchBatch({ transport: transport() });
    const before = await seatsOf(rid);
    await run('delivery.resend', { ids: [rid] }, { designs: { [pub]: designB } });
    const after = await seatsOf(rid);
    log('AC-9b', JSON.stringify(after.map((s) => [s.ticket_template_id, s.ticket_template_version])));
    expect(after.map((s) => s.ticket_template_id)).toEqual(before.map((s) => s.ticket_template_id));
  });

  it('AC-22 a SENDING ticket email is never superseded', async () => {
    const rid = await party(1, 'Flight');
    await run('delivery.send_tickets', { ids: [rid] });
    await sql`update email_outbox set status = 'SENDING', updated_at = now() where registration_id = ${rid}`;
    const r = await run('delivery.send_tickets', { ids: [rid] }, { templates: { [pub]: 'player_confirmation' } });
    const rows = await outbox(rid);
    log('AC-22', JSON.stringify({ done: r.done, skipped: r.skipped, outcome: r.items[0]?.outcome, rows }));
    expect(rows.map((x) => x.status)).toEqual(['SENDING']);
  });

  it('AC-17 round 2 reaches only the new people; AC-15 no double send across rounds', async () => {
    const a = await party(2, 'Round1');
    await run('delivery.send_tickets', { ids: [a] });
    const m1 = transport();
    await dispatchBatch({ transport: m1 });
    const b = await party(1, 'Round2', 'r2@example.test');
    const r = await run('delivery.send_tickets', { filter: {}, excludedIds: [] });
    const m2 = transport();
    await dispatchBatch({ transport: m2 });
    log('AC-17', JSON.stringify({ done: r.done, skipped: r.items.filter((i) => i.status === 'SKIPPED').map((i) => i.outcome), round2To: m2.sent.map((m) => m.to) }));
    expect(m2.sent.map((m) => m.to)).toEqual(['r2@example.test']);
    void b;
  });

  it('AC-20 an interrupted blast resumed never resends what went', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await party(1, `B${i}`, `b${i}@example.test`));
    await run('delivery.send_tickets', { ids });
    await setSystemSetting('email.max_per_dispatch', 2);
    const all: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = transport();
      await dispatchBatch({ transport: m });
      all.push(...m.sent.map((x) => x.to));
      // press Send again between batches
      await run('delivery.send_tickets', { ids });
    }
    log('AC-20', JSON.stringify(all));
    expect(all.sort()).toEqual(ids.map((_, i) => `b${i}@example.test`).sort());
  });

  it('AC-34 a trashed QUEUED message is not dispatched even when it reached the Trash another way', async () => {
    const rid = await party(1, 'Trash');
    await run('delivery.send_tickets', { ids: [rid] });
    await sql`update email_outbox set deleted_at = now() where registration_id = ${rid}`;
    const m = transport();
    await dispatchBatch({ transport: m });
    log('AC-34', m.sent.length);
    expect(m.sent).toHaveLength(0);
  });

  it('AC-40 the backlog is scoped to the concert in view', async () => {
    const rid = await party(1, 'Here');
    await run('delivery.send_tickets', { ids: [rid] });
    const other = await createConcert('Elsewhere');
    const b1 = await outboxBacklog(concertId);
    const b2 = await outboxBacklog(other);
    const all = await outboxBacklog();
    log('AC-40', JSON.stringify({ here: b1, other: b2, all }));
    expect(b1.resumable).toBe(1);
    expect(b2.resumable).toBe(0);
  });

  it('AC-33 the server refuses exits a status does not have', async () => {
    const rid = await party(1, 'Exit');
    await run('delivery.send_tickets', { ids: [rid] });
    await dispatchBatch({ transport: transport() });
    const [sent] = await outbox(rid);
    const out: Record<string, unknown> = {};
    for (const [cmd, params] of [['messages.retry', {}], ['messages.cancel', {}], ['messages.edit', { subject: 'x', bodyMd: 'y' }]] as const) {
      const r = await run(cmd, { ids: [Number(sent.id)] }, params);
      out[cmd] = { done: r.done, outcome: r.items[0]?.outcome };
    }
    await sql`update email_outbox set status = 'BOUNCED', bounced_at = now() where id = ${sent.id}`;
    const e = await run('messages.edit', { ids: [Number(sent.id)] }, { subject: 'x', bodyMd: 'y' });
    out['edit on BOUNCED'] = { done: e.done, outcome: e.items[0]?.outcome };
    const [row] = await sql<{ status: string; subject: string }[]>`select status, subject from email_outbox where id = ${sent.id}`;
    log('AC-33', JSON.stringify({ out, row }));
    expect(row.status).toBe('BOUNCED');
    expect(row.subject).not.toBe('x');
  });

  it('AC-31/48 resending a sent ticket email makes a new message and keeps tokens', async () => {
    const rid = await party(2, 'Again');
    await run('delivery.send_tickets', { ids: [rid] });
    await dispatchBatch({ transport: transport() });
    const before = await seatsOf(rid);
    const [sent] = await outbox(rid);
    const r = await run('messages.resend', { ids: [Number(sent.id)] });
    const rows = await outbox(rid);
    const after = await seatsOf(rid);
    log('AC-31', JSON.stringify({ done: r.done, rows }));
    expect(rows[0].status).toBe('SENT');
    expect(rows).toHaveLength(2);
    expect(after.map((s) => s.qr_token)).toEqual(before.map((s) => s.qr_token));
  });

  it('AC-37 Mark delivered by hand without a reason', async () => {
    const rid = await party(1, 'Hand');
    await run('delivery.send_tickets', { ids: [rid] });
    const r = await run('delivery.mark_delivered', { ids: [rid] }, {}, null);
    const seats = await seatsOf(rid);
    const [audit] = await sql<{ reason: string | null; action: string }[]>`
      select reason, action from audit_log where action = 'attendee.marked_delivered' order by id desc limit 1`;
    const sentRows = await sql<{ n: number }[]>`select count(*)::int n from email_outbox where registration_id = ${rid} and status in ('QUEUED','SENDING','SENT')`;
    log('AC-37', JSON.stringify({ done: r.done, seats: seats.map((s) => s.ticket_sent_source), audit, pendingOrSent: sentRows[0].n }));
    // spec email.md §11.6: "requires a short reason" — recorded, asserted in the report
    expect(sentRows[0].n).toBe(0);
  });

  it('AC-38 Cancel sending leaves SENDING and SENT alone', async () => {
    const a = await party(1, 'CS1');
    const b = await party(1, 'CS2', 'cs2@example.test');
    await run('delivery.send_tickets', { ids: [a, b] });
    await sql`update email_outbox set status = 'SENDING', updated_at = now() where registration_id = ${a}`;
    const r = await run('delivery.cancel_sending', { ids: [a, b] });
    log('AC-38', JSON.stringify({ done: r.done, a: await outbox(a), b: await outbox(b) }));
    expect((await outbox(a))[0].status).toBe('SENDING');
    expect((await outbox(b))[0].status).toBe('CANCELLED');
  });

  it('AC-49 a party with an unnamed guest is sent, not skipped', async () => {
    const { registrationId } = await createRegistration({
      segmentId: pub, contactName: 'Named', contactEmail: 'named@example.test',
      seats: [{ fullName: 'Named', allocationType: 'EXTRA' }, { fullName: null, allocationType: 'EXTRA' }],
    });
    const r = await run('delivery.send_tickets', { ids: [registrationId] });
    const m = transport();
    await dispatchBatch({ transport: m });
    const seats = await seatsOf(registrationId);
    log('AC-49', JSON.stringify({ done: r.done, sent: m.sent.length, delivered: seats.map((s) => !!s.ticket_sent_at) }));
    expect(r.done).toBe(1);
    expect(seats.every((s) => s.ticket_sent_at)).toBe(true);
  });

  it('AC-24 changing the email re-addresses pending, never SENT', async () => {
    const rid = await party(1, 'Move');
    await run('delivery.send_tickets', { ids: [rid] });
    await dispatchBatch({ transport: transport() });
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
              values (${rid}, 'REMINDER', 'reminder', 'party@example.test', 's', 'b', 'QUEUED')`;
    const changed = await changeContactEmail(concertId, rid, 'moved@example.com', null);
    const rows = await outbox(rid);
    log('AC-24', JSON.stringify({ changed, rows: rows.map((r) => [r.status, r.to_email]) }));
    expect(rows.find((r) => r.status === 'SENT')!.to_email).toBe('party@example.test');
    expect(rows.find((r) => r.status === 'QUEUED')!.to_email).toBe('moved@example.com');
  });

  it('AC-51 hostile params come back as structured refusals', async () => {
    const rid = await party(1, 'Hostile');
    const tries: [string, unknown][] = [
      ['non-numeric segment key', { designs: { 'x; drop table attendees': 1 } }],
      ['design id as string', { designs: { [pub]: 'abc' } }],
      ['template SQL', { templates: { [pub]: "public_ticket'; drop table email_outbox;--" } }],
      ['huge wording', { wording: { public_ticket: { subject: 'x'.repeat(600), bodyMd: 'y' } } }],
      ['unknown key', { evil: true }],
      ['design from another concert', { designs: { [pub]: 999999 } }],
    ];
    const results: Record<string, unknown> = {};
    for (const [label, params] of tries) {
      try {
        const r = await run('delivery.send_tickets', { ids: [rid] }, params);
        results[label] = { done: r.done, failed: r.failed, skipped: r.skipped, item: r.items[0] };
      } catch (e) {
        results[label] = { threw: (e as Error).constructor.name, message: (e as Error).message.slice(0, 200) };
      }
    }
    log('AC-51', JSON.stringify(results, null, 1));
    const [n] = await sql<{ n: number }[]>`select count(*)::int n from email_outbox`;
    expect(n.n).toBe(0);
  });

  it('AC-19/EXTRAS: a pending granted-extras email beside Send tickets', async () => {
    const rid = await party(1, 'Extras', 'ex@example.test');
    await run('delivery.send_tickets', { ids: [rid] });
    await sql`update email_outbox set status = 'CANCELLED' where registration_id = ${rid}`;
    // a legacy V1 extras_granted message still queued (carries tickets)
    const [ctx] = await sql<{ context: unknown }[]>`select context from email_outbox where registration_id = ${rid}`;
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, context)
              values (${rid}, 'EXTRAS_DECISION', 'extras_granted', 'ex@example.test', 'Granted', 'Your extras', 'QUEUED', ${JSON.stringify(ctx.context)}::jsonb)`;
    const p = await preview('delivery.send_tickets', { ids: [rid] });
    const r = await run('delivery.send_tickets', { ids: [rid] });
    const m = transport();
    await dispatchBatch({ transport: m });
    log('EXTRAS', JSON.stringify({ preview: p.rows, blast: p.blastRadius, done: r.done, sent: m.sent.map((x) => [x.subject, x.attachments?.length ?? 0]) }));
  });

  it('AC-43b cross-concert selection is refused', async () => {
    const other = await createConcert('Other');
    const oshow = await createShow(other, 50);
    const oseg = await createSegment(oshow, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const foreign = await party(1, 'Foreign', 'f@example.test', oseg);
    let res: unknown;
    try {
      const r = await run('delivery.send_tickets', { ids: [foreign] });
      res = { done: r.done, items: r.items };
    } catch (e) {
      res = { threw: (e as Error).message };
    }
    log('XCONCERT', JSON.stringify(res));
    expect((await outbox(foreign)).length).toBe(0);
  });
});
