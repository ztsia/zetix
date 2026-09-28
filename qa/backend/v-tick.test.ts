import { expect, it, vi } from 'vitest';
import { sql } from '../../tests/helpers/db';

/**
 * QA module V, AC-12: the receipt's hold against the REAL tick route of the
 * running dev server (qa/support/start-v.sh, CRON_SECRET=qa-cron-secret,
 * SMTP sink on :2526). Does not reset the database — runs on the V seed.
 */
vi.mock('node:dns', () => ({ promises: { resolveMx: vi.fn(async () => [{ exchange: 'mx.example.test', priority: 10 }]), lookup: vi.fn() } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': '198.51.100.201' }) }));

const tick = async () =>
  (await fetch('http://localhost:3100/api/scheduler/tick', { method: 'POST', headers: { authorization: 'Bearer qa-cron-secret' } })).json();

it('a held receipt is not sent by a tick before its hold ends, and is sent by the first tick after', async () => {
  const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');
  const r = await submitRegistration({
    slug: 'qa-autumn', token: null, schemaVersion: 1, addressConfirmed: true,
    answers: {
      registrant: { kind: 'flat', values: { contact_name: 'Tick Tester', contact_email: 'tick@example.test', contact_phone: '' } },
      party: { kind: 'repeater', rows: [] },
    },
  });
  expect(r.ok).toBe(true);
  const [receipt] = await sql<{ id: number; status: string; scheduled_for: Date }[]>`
    select o.id::int, o.status::text, o.scheduled_for from email_outbox o join registrations g on g.id = o.registration_id
     where g.contact_email = 'tick@example.test' and o.purpose = 'RECEIPT'`;
  const first = await tick();
  const [afterFirst] = await sql<{ status: string }[]>`select status::text from email_outbox where id = ${receipt.id}`;
  await sql`update email_outbox set scheduled_for = now() - interval '1 second' where id = ${receipt.id}`;
  const second = await tick();
  const [afterSecond] = await sql<{ status: string; sent_at: Date | null }[]>`select status::text, sent_at from email_outbox where id = ${receipt.id}`;
  console.log(`EVID AC-12 ${JSON.stringify({ heldUntil: receipt.scheduled_for, statusAfterTickInsideHold: afterFirst.status, firstDispatch: first.dispatch?.result, statusAfterTickPastHold: afterSecond.status, secondDispatch: second.dispatch?.result })}`);
  expect(afterFirst.status).toBe('QUEUED');
  expect(afterSecond.status).toBe('SENT');
});
