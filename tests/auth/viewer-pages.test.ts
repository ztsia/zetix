import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Does every admin page mask what it hands a VIEWER's browser? (spec/v3.md §28)
 *
 * Masking is opt-in per page — each one passes its props through
 * `maskForRole()` — and an independent QA pass found the ticket designer handing
 * a viewer a real attendee's `qr_token`, and showed that deleting the call from
 * Registrations left the suite green. This renders every viewer-readable page as
 * a viewer and walks the element tree it returns: every prop a Client Component
 * would receive is in it, so a secret found there is a secret in the RSC
 * payload.
 *
 * Each page is also rendered as an admin, and at least the pages that show
 * contacts must then contain them — without that, a page that loaded nothing
 * would pass for a page that masked everything.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  usePathname: () => '/',
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'ana@example.test', displayName: 'Ana', role: 'ADMIN' };
const VIEWER = { id: '00000000-0000-4000-8000-0000000000bb', email: 'mei@example.test', displayName: 'Mei', role: 'VIEWER' };

const CONTACT_EMAIL = 'farah.secret@example.test';
const PHONE_DIGITS = '313 1313';
const PLAYER_EMAIL = 'player.secret@example.test';
const TRASH_EMAIL = 'trash.secret@example.test';
const AUDIT_EMAIL = 'audit.secret@example.test';

let concertId: number;
let templateId: number;
let secrets: string[] = [];

const C = '@/app/(admin)/admin/concerts/[concertId]';
/** Every viewer-readable page that takes a concert, with the query it needs. */
const PAGES: Array<[string, Record<string, string>]> = [
  ['home', {}],
  ['setup', {}],
  ['shows', {}],
  ['players', {}],
  ['forms', {}],
  // Registrations, Unverified, Extras review and Tickets redirect to the
  // Audience workspace now (spec/v3.md §22.1); these are their views.
  ['audience', {}],
  ['audience', { grain: 'seats' }],
  ['audience', { view: 'needs-review' }],
  ['audience', { q: 'secret' }],
  ['import', {}],
  ['tickets/templates', {}],
  // Email and Email › Delivery redirect to Audience › Messages now
  // (spec/v3.md §24.4); these are its tabs and its search.
  ['audience/messages', {}],
  ['audience/messages', { status: 'FAILED' }],
  ['audience/messages', { q: 'secret' }],
  ['email/templates', {}],
  ['checkin', {}],
  ['operators', {}],
  ['portal', {}],
  ['notes', {}],
  ['inbox', {}],
  ['inbox', { view: 'all' }],
  ['inbox', { view: 'bounces' }],
  ['activity', {}],
  ['trash', { kind: 'party' }],
  ['trash', { kind: 'player' }],
];

/** Every string anywhere in what a page returned. */
function strings(node: unknown, seen = new WeakSet<object>(), out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') {
    if (seen.has(node)) return out;
    seen.add(node);
    if (node instanceof Date) return out;
    for (const value of Array.isArray(node) ? node : Object.values(node)) strings(value, seen, out);
  }
  return out;
}

async function render(path: string, query: Record<string, string>, extra: Record<string, string> = {}) {
  const Page = (await import(`${C}/${path}/page`)).default as (props: unknown) => Promise<unknown>;
  const props = {
    params: Promise.resolve({ concertId: String(concertId), ...extra }),
    searchParams: Promise.resolve(query),
  };
  try {
    return await Page(props);
  } catch (error) {
    // A page that picks a default by redirecting (extras-review) is followed once.
    if (!(error instanceof RedirectSignal)) throw error;
    const next = Object.fromEntries(new URL(error.to, 'http://x').searchParams);
    return Page({ ...props, searchParams: Promise.resolve({ ...query, ...next }) });
  }
}

/** The first value under `key` anywhere in a rendered tree: a prop handed to a component. */
function findProp(node: unknown, key: string, seen = new WeakSet<object>()): unknown {
  if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
  seen.add(node);
  if (!Array.isArray(node) && key in node) return (node as Record<string, unknown>)[key];
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findProp(value, key, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function leaks(output: unknown): string[] {
  const text = strings(output).join('\n');
  return secrets.filter((secret) => text.includes(secret));
}

beforeAll(async () => {
  await resetDb();
  await sql`
    insert into app_users (id, email, display_name, role) values
      (${ADMIN.id}, ${ADMIN.email}, 'Ana', 'ADMIN'),
      (${VIEWER.id}, ${VIEWER.email}, 'Mei', 'VIEWER')
  `;
  concertId = await createConcert('Masked Concert');
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100 });

  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Farah' });
  await sql`
    update registrations set contact_email = ${CONTACT_EMAIL}, contact_phone = '+60 17-313 1313'
     where id = ${registrationId}
  `;
  await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
  await issueTickets(concertId, showId);

  const [playerId] = await createPlayers(concertId, 1);
  await sql`update players set email = ${PLAYER_EMAIL} where id = ${playerId!}`;

  const gone = await createRegistration({ showId, segmentId, contactName: 'Gone' });
  await sql`update registrations set contact_email = ${TRASH_EMAIL}, deleted_at = now() where id = ${gone}`;
  await sql`update players set deleted_at = now() where id = ${playerId!}`;
  const [kept] = await createPlayers(concertId, 1);
  await sql`update players set email = ${PLAYER_EMAIL.replace('player', 'kept')} where id = ${kept!}`;

  await sql`
    insert into audit_log (action, entity_type, entity_id, concert_id, actor_id, reason, before, after)
    values ('registration.updated', 'registrations', ${String(registrationId)}, ${concertId}, ${ADMIN.id},
            ${`asked by ${AUDIT_EMAIL}`},
            ${JSON.stringify({ contact_email: 'old.secret@example.test' })}::jsonb,
            ${JSON.stringify({ contact_email: CONTACT_EMAIL })}::jsonb)
  `;

  const [template] = await sql`select id from ticket_templates where concert_id = ${concertId} limit 1`;
  templateId = Number(template!.id);

  const tokens = await sql<{ qr_token: string }[]>`select qr_token from attendees where qr_token is not null`;
  const invites = await sql<{ invite_token: string }[]>`select invite_token from players`;
  secrets = [
    CONTACT_EMAIL,
    PHONE_DIGITS,
    PLAYER_EMAIL.replace('player', 'kept'),
    TRASH_EMAIL,
    AUDIT_EMAIL,
    'old.secret@example.test',
    ...tokens.map((t) => t.qr_token),
    ...invites.map((t) => t.invite_token),
  ];
  expect(tokens.length).toBe(2);
});

describe('every admin page, rendered for a VIEWER', () => {
  for (const [path, query] of PAGES) {
    it(`${path} ${JSON.stringify(query)} carries no contact detail or token`, async () => {
      sessionUser.mockResolvedValue(VIEWER);
      expect(leaks(await render(path, query))).toEqual([]);
    });
  }

  it('the import staging grid masks staged addresses, and its search ignores them', async () => {
    const [segment] = await sql<{ id: string; show_id: string }[]>`
      select g.id, g.show_id from show_segments g join shows s on s.id = g.show_id where s.concert_id = ${concertId} limit 1`;
    const [batch] = await sql<{ id: string }[]>`
      insert into import_batches (show_id, segment_id, filename, status, report)
      values (${segment!.show_id}, ${segment!.id}, 'staged.csv', 'STAGED', '{}'::jsonb) returning id`;
    const fields = {
      contactName: 'Staged Sam',
      contactEmail: 'staged.secret@example.test',
      requestedAt: null,
      requestedAtRaw: null,
      attendeeName: 'Sam',
      attendeeEmail: 'staged.guest@example.test',
      allocationType: 'EXTRA',
      allocationRaw: null,
      groupKey: null,
      playerNeedle: null,
      playerId: null,
      playerName: null,
      playerConfirmed: false,
      playerConfidence: null,
    };
    await sql`
      insert into import_rows (batch_id, row_number, seat_index, raw, normalized, issues, status, party_key)
      values (${batch!.id}, 2, 0, ${JSON.stringify({ Email: 'staged.secret@example.test' })}::jsonb,
              ${JSON.stringify(fields)}::jsonb, '[]'::jsonb, 'STAGED', 'e:staged.secret@example.test')`;
    const render_ = (query: Record<string, string>) =>
      render('import/[batchId]', query, { batchId: String(batch!.id) }).then((out) => strings(out).join('\n'));

    sessionUser.mockResolvedValue(VIEWER);
    const shown = await render_({ view: 'all' });
    expect(shown).toContain('Staged Sam');
    expect(shown).not.toContain('staged.secret@example.test');
    expect(shown).not.toContain('staged.guest@example.test');
    // A search on the masked address finds nothing for a viewer.
    expect(await render_({ view: 'all', q: 'staged.secret' })).not.toContain('Staged Sam');
  });

  it('the ticket designer offers a viewer the sample attendee only', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const output = await render('tickets/templates/[templateId]', {}, { templateId: String(templateId) });
    expect(leaks(output)).toEqual([]);
    expect(strings(output).join('\n')).not.toContain('Guest 1');
  });

  it('the party record masks every section, not just its header', async () => {
    // Every section of the record carries a secret: a reply quoting the links
    // the system mailed, a failed send quoting a dotless address and a phone,
    // a form answer keyed by a block id, and an audit row of the entity type
    // the record actually reads. Module S's QA found this test green while the
    // record handed all of them over, because none of them existed here.
    const [party] = await sql<{ id: string; segment_id: string; show_id: string }[]>`
      select id, segment_id, show_id from registrations where contact_name = 'Farah' and deleted_at is null`;
    const id = Number(party!.id);
    const [form] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, title, slug, status, kind)
      values (${party!.segment_id}, 'Record form', 'record-form', 'OPEN', 'PUBLIC') returning id`;
    const [response] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${form!.id}, ${JSON.stringify({ b7: '+60 12-777 8888' })}::jsonb, '{}'::jsonb, now()) returning id`;
    await sql`update registrations set form_response_id = ${response!.id} where id = ${id}`;
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, attempts, last_error)
      values (${id}, 'TICKETS', 'public_ticket', ${CONTACT_EMAIL}, 'Your tickets', 'b', 'FAILED', 3,
              '550 no such user nodot@examplecom, call +60 17-313 1313')`;
    const [thread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id) values (${id}) returning id`;
    await sql`
      insert into email_messages (thread_id, direction, from_email, subject, text, message_at)
      values (${thread!.id}, 'INBOUND', ${CONTACT_EMAIL}, 'Re: tickets',
              ${'> edit: https://x.test/f/a/edit?r=EDITSECRET01\n> verify: https://x.test/f/verify?t=VERSECRET01\n> invite ?k=INVSECRET01'},
              now())`;
    await sql`
      insert into audit_log (action, entity_type, entity_id, concert_id, actor_id, reason, after)
      values ('registration.updated', 'registration', ${String(id)}, ${concertId}, ${ADMIN.id},
              ${'phoned on +60 19-555 0000'}, ${JSON.stringify({ contactEmail: 'record.audit@example.test' })}::jsonb)`;
    const recordSecrets = [
      'nodot@examplecom',
      '313 1313',
      '777 8888',
      'EDITSECRET01',
      'VERSECRET01',
      'INVSECRET01',
      '555 0000',
      'record.audit@example.test',
    ];

    const renderRecord = async () =>
      strings(await render('audience/[registrationId]', {}, { registrationId: String(id) })).join('\n');

    sessionUser.mockResolvedValue(ADMIN);
    const asAdmin = await renderRecord();
    for (const secret of recordSecrets) expect(asAdmin, `admin sees ${secret}`).toContain(secret);

    sessionUser.mockResolvedValue(VIEWER);
    const asViewer = await renderRecord();
    for (const secret of [...recordSecrets, ...secrets]) {
      expect(asViewer, `viewer must not see ${secret}`).not.toContain(secret);
    }
  });

  it('the Inbox and a player’s thread mask the replies they list', async () => {
    const [party] = await sql<{ id: string }[]>`
      select id from registrations where contact_name = 'Farah' and deleted_at is null`;
    const [player] = await sql<{ id: string }[]>`select id from players where deleted_at is null limit 1`;
    const [partyThread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id, last_message_at) values (${party!.id}, now())
      on conflict (registration_id) do update set last_message_at = now() returning id`;
    const [playerThread] = await sql<{ id: string }[]>`
      insert into email_threads (player_id, last_message_at) values (${player!.id}, now()) returning id`;
    await sql`
      insert into email_messages (thread_id, direction, from_email, subject, text, message_at) values
        (${partyThread!.id}, 'INBOUND', ${CONTACT_EMAIL}, 'Re: inbox', ${'call me on +60 16-222 3333, or inbox.secret@example.test'}, now()),
        (${playerThread!.id}, 'INBOUND', 'player.thread@example.test', 'Re: digest', ${'ring +60 16-444 5555'}, now())`;
    const inboxSecrets = ['222 3333', 'inbox.secret@example.test', '444 5555', 'player.thread@example.test'];

    const renderAll = async () =>
      [
        ...strings(await render('inbox', { view: 'all' })),
        ...strings(await render('inbox/[threadId]', {}, { threadId: String(playerThread!.id) })),
      ].join('\n');

    sessionUser.mockResolvedValue(ADMIN);
    const asAdmin = await renderAll();
    for (const secret of inboxSecrets) expect(asAdmin, `admin sees ${secret}`).toContain(secret);

    sessionUser.mockResolvedValue(VIEWER);
    const asViewer = await renderAll();
    for (const secret of [...inboxSecrets, ...secrets]) {
      expect(asViewer, `viewer must not see ${secret}`).not.toContain(secret);
    }
  });

  it('a viewer’s view counts do not count what their search may not match', async () => {
    const countsFor = async (role: typeof ADMIN) => {
      sessionUser.mockResolvedValue(role);
      return findProp(await render('audience', { q: 'farah.secret' }), 'counts') as { all: number };
    };
    expect((await countsFor(ADMIN)).all).toBe(1);
    expect((await countsFor(VIEWER)).all).toBe(0);
  });

  it('a viewer’s Audience search does not match on a masked address', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const text = strings(await render('audience', { q: 'farah.secret' })).join('\n');
    expect(text).not.toContain('Farah');
    sessionUser.mockResolvedValue(ADMIN);
    const admin = strings(await render('audience', { q: 'farah.secret' })).join('\n');
    expect(admin).toContain('Farah');
  });

  it('Settings › People masks the accounts’ addresses', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const Page = (await import('@/app/(admin)/admin/settings/people/page')).default;
    const text = strings(await Page()).join('\n');
    expect(text).not.toContain(ADMIN.email);
  });
});

describe('the same pages for an ADMIN — the check above has something to find', () => {
  it('Registrations, Messages, Players, Trash, Activity and the designer show the real values', async () => {
    sessionUser.mockResolvedValue(ADMIN);
    const all = [
      ...strings(await render('audience', {})),
      ...strings(await render('audience', { grain: 'seats' })),
      ...strings(await render('audience/messages', {})),
      ...strings(await render('players', {})),
      ...strings(await render('trash', { kind: 'party' })),
      ...strings(await render('activity', {})),
      ...strings(await render('tickets/templates/[templateId]', {}, { templateId: String(templateId) })),
    ].join('\n');
    for (const secret of [CONTACT_EMAIL, PHONE_DIGITS, TRASH_EMAIL, AUDIT_EMAIL]) {
      expect(all, secret).toContain(secret);
    }
    expect(secrets.slice(-3).some((token) => all.includes(token))).toBe(true);
  });
});
