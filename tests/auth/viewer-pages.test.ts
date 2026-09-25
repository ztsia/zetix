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
  ['overview', {}],
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
  ['email', {}],
  ['email/delivery', {}],
  ['email/templates', {}],
  ['checkin', {}],
  ['operators', {}],
  ['portal', {}],
  ['notes', {}],
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

  it('the ticket designer offers a viewer the sample attendee only', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const output = await render('tickets/templates/[templateId]', {}, { templateId: String(templateId) });
    expect(leaks(output)).toEqual([]);
    expect(strings(output).join('\n')).not.toContain('Guest 1');
  });

  it('the party record masks contacts and withholds raw answers', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    const [party] = await sql<{ id: string }[]>`
      select id from registrations where contact_name = 'Farah' and deleted_at is null`;
    const output = await render('audience/[registrationId]', {}, { registrationId: String(party!.id) });
    expect(leaks(output)).toEqual([]);
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
  it('Registrations, Delivery, Players, Trash, Activity and the designer show the real values', async () => {
    sessionUser.mockResolvedValue(ADMIN);
    const all = [
      ...strings(await render('audience', {})),
      ...strings(await render('audience', { grain: 'seats' })),
      ...strings(await render('email/delivery', {})),
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
