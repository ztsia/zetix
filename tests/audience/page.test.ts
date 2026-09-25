import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * The Audience pages on the server side (spec/v3.md §22.1, §22.4): the guard,
 * the scoping, what the URL asks for, and the retired screens' redirects. No
 * browser: the page components are called and the props they hand the table
 * are inspected. Only `getSessionUser` is stubbed, as route-guards.test.ts does.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  useRouter: () => ({}),
  usePathname: () => '',
}));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const base = '@/app/(admin)/admin/concerts/[concertId]';
const AudiencePage = (await import(`${base}/audience/page`)).default;
const RecordPage = (await import(`${base}/audience/[registrationId]/page`)).default;
const { AudienceTable } = await import(`${base}/audience/audience-table`);
const { PartyRecord } = await import(`${base}/audience/[registrationId]/party-record`);
const retired = {
  registrations: (await import(`${base}/registrations/page`)).default,
  unverified: (await import(`${base}/registrations/unverified/page`)).default,
  extras: (await import(`${base}/extras-review/page`)).default,
  tickets: (await import(`${base}/tickets/page`)).default,
};

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** The first element of `type` anywhere in a rendered tree. */
function find(node: unknown, type: unknown): Element | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const element = node as Element;
  if (element.type === type) return element;
  return find(element.props?.children, type);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    if (error instanceof NotFoundSignal) return 'notFound';
    throw error;
  }
}

let concertId: number;
let segmentId: number;

const audience = (query: Record<string, string> = {}, id = concertId) =>
  AudiencePage({
    params: Promise.resolve({ concertId: String(id) }),
    searchParams: Promise.resolve(query),
  });

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  const admin = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${admin}::uuid, ${`a-${admin}@example.test`}, 'Committee', 'ADMIN')
  `;
  sessionUser.mockResolvedValue({ id: admin, email: 'a@x', displayName: 'Committee', role: 'ADMIN' });
  concertId = await createConcert('Pages');
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, extrasPolicy: 'AUTO_FCFS' });
});

describe('the Audience page', () => {
  it('lists parties by default and seats when the URL asks, with view counts', async () => {
    const a = await createRegistration({
      segmentId,
      contactName: 'Ada',
      seats: [
        { fullName: 'Ada', allocationType: 'EXTRA' },
        { fullName: 'Bo', allocationType: 'EXTRA' },
      ],
    });
    const parties = find(await audience(), AudienceTable)!;
    expect(parties.props.grain).toBe('parties');
    expect((parties.props.page as { total: number }).total).toBe(1);
    expect((parties.props.counts as { views: Record<string, number> }).views['needs-tickets']).toBe(1);

    const seats = find(await audience({ grain: 'seats', view: 'needs-tickets' }), AudienceTable)!;
    expect(seats.props.grain).toBe('seats');
    const rows = (seats.props.page as { rows: { registrationId: number }[] }).rows;
    expect(rows.map((r) => r.registrationId)).toEqual([a.registrationId, a.registrationId]);
  });

  it('turns away anyone signed out, an operator, and a concert that does not exist', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => audience())).toBe('redirect:/login');
    sessionUser.mockResolvedValue({ id: randomUUID(), email: 'o@x', displayName: 'Op', role: 'OPERATOR' });
    expect(await outcome(() => audience())).not.toBe('allowed');
    sessionUser.mockResolvedValue({ id: randomUUID(), email: 'a@x', displayName: 'A', role: 'ADMIN' });
    expect(await outcome(() => audience({}, 999_999))).toBe('notFound');
  });
});

describe('the party record page', () => {
  it('renders a party of this concert and 404s one of another concert', async () => {
    const a = await createRegistration({ segmentId, contactName: 'Ada', seats: [{ fullName: 'Ada', allocationType: 'EXTRA' }] });
    const tree = await RecordPage({
      params: Promise.resolve({ concertId: String(concertId), registrationId: String(a.registrationId) }),
    });
    const record = find(tree, PartyRecord)!;
    expect((record.props.record as { party: { contactName: string } }).party.contactName).toBe('Ada');

    const other = await createConcert('Other');
    expect(
      await outcome(() =>
        RecordPage({ params: Promise.resolve({ concertId: String(other), registrationId: String(a.registrationId) }) }),
      ),
    ).toBe('notFound');
  });
});

describe('the retired screens', () => {
  it('redirect to their Audience view', async () => {
    const params = Promise.resolve({ concertId: String(concertId) });
    const to = `/admin/concerts/${concertId}/audience`;
    expect(await outcome(() => retired.registrations({ params }))).toBe(`redirect:${to}`);
    expect(await outcome(() => retired.unverified({ params }))).toBe(`redirect:${to}?view=unverified`);
    expect(await outcome(() => retired.tickets({ params }))).toBe(`redirect:${to}?grain=seats`);
    expect(
      await outcome(() => retired.extras({ params, searchParams: Promise.resolve({ segment: String(segmentId) }) })),
    ).toBe(`redirect:${to}?view=needs-review&segment=${segmentId}`);
  });
});
