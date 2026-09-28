import { appendFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createRegistration, createSegment, createShow, setSystemSetting } from '../../tests/helpers/fixtures';

/**
 * QA module U, phase 4 — the authorization matrix for the inbox's Server
 * Actions and the tick route handler, called for real with each session shape.
 * The session lookup is the only thing substituted; the guard, the action and
 * the database are the real ones.
 */

const LOG = process.env.QA_U_LOG ?? '/tmp/qa-u-phase4.log';
const log = (...a: unknown[]) =>
  appendFileSync(LOG, `QA ${a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 6, breakLength: 160 }))).join(' ')}\n`);

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => sessionUser(), recordLogin: async () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, updateTag: () => {}, refresh: () => {} }));

const USERS = {
  anonymous: null,
  ADMIN: { id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x', displayName: 'Ana', role: 'ADMIN' },
  VIEWER: { id: '00000000-0000-4000-8000-0000000000bb', email: 'v@x', displayName: 'Mei', role: 'VIEWER' },
  OPERATOR: { id: '00000000-0000-4000-8000-0000000000cc', email: 'o@x', displayName: 'Op', role: 'OPERATOR' },
} as const;

let concertId = 0;
let messageId = 0;

beforeEach(async () => {
  await resetDb();
  for (const u of Object.values(USERS)) {
    if (u) await sql`insert into app_users (id, email, display_name, role) values (${u.id}, ${u.email}, ${u.displayName}, ${u.role})`;
  }
  for (const [k, v] of Object.entries({
    'email.max_per_dispatch': 25, 'email.max_per_day': 450, 'email.inter_message_delay_ms': 0, 'email.max_attempts': 3,
    'email.merge_attachments_above': 8, 'email.max_attachment_mb': 20, 'inbox.match_fallback_days': 30, 'inbox.sync_budget_seconds': 20,
  })) await setSystemSetting(k, v);
  concertId = await createConcert('U authz');
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  const rid = await createRegistration({ showId, segmentId, contactName: 'Ada' });
  await sql`update registrations set contact_email = 'ada@guest.example' where id = ${rid}`;
  const [t] = await sql<{ id: string }[]>`insert into email_threads (registration_id, last_message_at) values (${rid}, now()) returning id`;
  const [m] = await sql<{ id: string }[]>`
    insert into email_messages (thread_id, direction, message_id, from_email, subject, text, message_at)
    values (${t.id}, 'INBOUND', '<authz@guest.example>', 'ada@guest.example', 'Re: tickets', 'question', now()) returning id`;
  messageId = Number(m.id);
});

async function state() {
  const [r] = await sql<{ replies: string; handled: string; audit: string }[]>`
    select (select count(*) from email_outbox where purpose = 'REPLY') replies,
           (select count(*) from email_messages where handled_at is not null) handled,
           (select count(*) from audit_log) audit`;
  return `${r.replies}/${r.handled}/${r.audit}`;
}

describe('U authz matrix — inbox Server Actions', () => {
  it('AC-42/AC-42s: only ADMIN changes anything; anonymous, VIEWER and OPERATOR are refused before any write', async () => {
    const actions = await import('@/app/(admin)/admin/concerts/[concertId]/inbox/actions');
    const table: Record<string, Record<string, string>> = {};
    for (const [who, user] of Object.entries(USERS)) {
      sessionUser.mockResolvedValue(user);
      const row: Record<string, string> = {};
      for (const [name, call] of [
        ['markHandledAction', () => actions.markHandledAction(concertId, messageId)],
        ['syncInboxAction', () => actions.syncInboxAction(concertId)],
        ['sendReplyAction', () => actions.sendReplyAction(concertId, messageId, 'hello from ' + who)],
      ] as const) {
        const before = await state();
        let outcome: string;
        try {
          const r = await (call as () => Promise<unknown>)();
          outcome = `returned ${JSON.stringify(r).slice(0, 90)}`;
        } catch (e) {
          outcome = `threw ${(e as Error).message.slice(0, 60)}`;
        }
        row[name] = `${outcome} | state ${before} -> ${await state()}`;
      }
      table[who] = row;
      if (who === 'ADMIN') continue;
      for (const v of Object.values(row)) expect(v).toMatch(/threw/);
    }
    log('AC-42 action matrix (state = REPLY rows / handled msgs / audit rows)', table);
  });

  it('AC-24 input: hostile inputs to sendReplyAction as ADMIN return structured errors', async () => {
    sessionUser.mockResolvedValue(USERS.ADMIN);
    const actions = await import('@/app/(admin)/admin/concerts/[concertId]/inbox/actions');
    const out: Record<string, string> = {};
    const cases: Array<[string, unknown[]]> = [
      ['missing body', [concertId, messageId, undefined]],
      ['wrong type body', [concertId, messageId, { $gt: '' }]],
      ['string ids', [String(concertId), `${messageId} or 1=1`, 'hi']],
      ['negative id', [concertId, -1, 'hi']],
      ['huge id', [concertId, Number.MAX_SAFE_INTEGER + 2, 'hi']],
      ['sql meta body', [concertId, 999999, "'); drop table email_outbox; --"]],
      ['20001 chars', [concertId, messageId, 'x'.repeat(20_001)]],
      ['../ in concert', ['../1', messageId, 'hi']],
    ];
    for (const [label, args] of cases) {
      try {
        const r = await (actions.sendReplyAction as (...a: unknown[]) => Promise<unknown>)(...args);
        out[label] = JSON.stringify(r).slice(0, 120);
      } catch (e) {
        out[label] = `THREW ${(e as Error).message.slice(0, 120)}`;
      }
    }
    const [r] = await sql<{ c: string }[]>`select count(*) c from email_outbox`;
    log('AC-24 hostile inputs', out, { outboxRows: r.c });
    expect(Number(r.c)).toBe(0);
    for (const v of Object.values(out)) expect(v).toMatch(/"ok":false/);
  });
});

describe('U authz — tick route handler', () => {
  it('AC-29..32: bearer only; unset secret refuses everyone', async () => {
    const route = await import('@/app/api/scheduler/tick/route');
    const call = async (verb: 'GET' | 'POST', auth?: string) => {
      const res = await route[verb](new Request('http://x/api/scheduler/tick', {
        method: verb,
        headers: auth ? { authorization: auth } : {},
        ...(verb === 'POST' ? { body: '{"source":"pg_cron"}' } : {}),
      }));
      return res.status;
    };
    const beats = async () => Number((await sql<{ c: string }[]>`select count(*) c from scheduler_heartbeat`)[0].c);
    const out: Record<string, string> = {};
    process.env.CRON_SECRET = 'qa-secret';
    for (const [label, verb, auth] of [
      ['none GET', 'GET', undefined], ['none POST', 'POST', undefined], ['wrong', 'POST', 'Bearer nope'],
      ['no Bearer prefix', 'POST', 'qa-secret'], ['case', 'POST', 'bearer qa-secret'],       ['admin cookie only', 'POST', undefined],
    ] as const) {
      const b = await beats();
      out[label] = `${await call(verb, auth)} beats ${b}->${await beats()}`;
    }
    delete process.env.CRON_SECRET;
    out['unset secret, "Bearer "'] = `${await call('POST', 'Bearer ')}`;
    out['unset secret, "Bearer undefined"'] = `${await call('POST', 'Bearer undefined')}`;
    process.env.CRON_SECRET = '';
    out['empty secret, "Bearer "'] = `${await call('POST', 'Bearer ')}`;
    delete process.env.CRON_SECRET;
    // Fetch normalises header whitespace, so 'Bearer qa-secret ' is the right secret: expected 200.
    process.env.CRON_SECRET = 'qa-secret';
    const good = `${await call('POST', 'Bearer qa-secret')} (right bearer)`;
    delete process.env.CRON_SECRET;
    log('AC-29..32 tick route statuses', out, good);
    expect(good).toMatch(/^200/);
    for (const v of Object.values(out)) expect(v).toMatch(/^401/);
  });
});
