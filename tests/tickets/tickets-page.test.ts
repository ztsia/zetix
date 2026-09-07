import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * The admin tickets screen, on the server side.
 *
 * No browser is involved: this calls the real page component and inspects the
 * props it hands `TicketsTable`. That covers the guard, the query, the scoping
 * and the §10.6 count — everything except how it looks, which is queued as a
 * human task in `local.md` because signing in needs an admin code no cloud
 * session holds (§7).
 *
 * Only `getSessionUser` is stubbed, and only here in the test: it is the one
 * leaf that needs Supabase (route-guards.test.ts does the same).
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
}));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const TicketsPage = (await import('@/app/(admin)/admin/concerts/[concertId]/tickets/page'))
  .default;
const { issueTickets } = await import('@/lib/tickets/issue');

type TableProps = {
  rows: { id: number; fullName: string; issued: boolean; needsReissue: boolean;
          templateVersion: number | null; showId: number }[];
  rowCount: number;
  needsReissueCount: number;
  timeZone: string;
  shows: { id: number; name: string }[];
};

async function render(
  concertId: number,
  query: Record<string, string> = {},
): Promise<TableProps> {
  const element = (await TicketsPage({
    params: Promise.resolve({ concertId: String(concertId) }),
    searchParams: Promise.resolve(query),
  })) as unknown as { props: TableProps };
  return element.props;
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
let showA: number;
let showB: number;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  const admin = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${admin}::uuid, ${`a-${admin}@example.test`}, 'Committee', 'ADMIN')
  `;
  sessionUser.mockResolvedValue({
    id: admin, email: 'a@x', displayName: 'Committee', role: 'ADMIN',
  });

  concertId = await createConcert('Screen');
  showA = await createShow(concertId, 100);
  showB = await createShow(concertId, 100);

  for (const [show, count] of [[showA, 3], [showB, 2]] as const) {
    const segment = await createSegment(show, { capacity: 50, audienceMode: 'PUBLIC' });
    const registration = await createRegistration({ showId: show, segmentId: segment });
    await seedAttendees({
      registrationId: registration, showId: show, segmentId: segment,
      count, allocationType: 'BASE',
    });
  }
});

describe('the tickets screen', () => {
  it('lists every attendee in the concert', async () => {
    const props = await render(concertId);
    expect(props.rowCount).toBe(5);
    expect(props.rows).toHaveLength(5);
    // Nothing issued yet, so nothing is renderable.
    expect(props.rows.every((r) => !r.issued)).toBe(true);
  });

  it('reports the pinned template version once tickets are issued', async () => {
    await issueTickets({ concertId, showId: showA });

    const props = await render(concertId);
    const issued = props.rows.filter((r) => r.issued);
    expect(issued).toHaveLength(3);
    expect(issued.every((r) => r.templateVersion === 1)).toBe(true);
    // The other show is untouched — issuing is scoped.
    expect(props.rows.filter((r) => !r.issued)).toHaveLength(2);
  });

  it('filters to one show when asked', async () => {
    const props = await render(concertId, { show: String(showB) });
    expect(props.rowCount).toBe(2);
    expect(props.rows.every((r) => r.showId === showB)).toBe(true);
  });

  it('searches by name across the whole concert, not just the page', async () => {
    const props = await render(concertId, { q: 'Guest 1' });
    // Server-side search: the count reflects matches everywhere, which is the
    // whole reason the table runs in server mode (modules.md §5.2.1).
    expect(props.rowCount).toBeGreaterThan(0);
    expect(props.rows.every((r) => r.fullName.includes('Guest 1'))).toBe(true);
  });

  it('pages without losing the total', async () => {
    const props = await render(concertId, { size: '10', page: '0' });
    expect(props.rowCount).toBe(5);
    expect(props.rows.length).toBeLessThanOrEqual(10);
  });

  it('counts tickets needing reissue across the concert, not the page', async () => {
    // §10.6: the count is a call to action, so it must not shrink when an admin
    // narrows the list or turns to page two.
    await issueTickets({ concertId, showId: showA });
    await sql`update attendees set ticket_sent_at = now(), needs_reissue = true where show_id = ${showA}`;

    const all = await render(concertId);
    expect(all.needsReissueCount).toBe(3);

    const filtered = await render(concertId, { show: String(showB) });
    expect(filtered.needsReissueCount).toBe(3);
  });

  it('offers every show in the concert as a filter', async () => {
    const props = await render(concertId);
    expect(props.shows.map((s) => s.id).sort()).toEqual([showA, showB].sort());
  });

  it("renders timestamps in the concert's zone", async () => {
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}`;
    const props = await render(concertId);
    expect(props.timeZone).toBe('Asia/Kuala_Lumpur');
  });

  it('turns away anyone who is not signed in', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => render(concertId))).toBe('redirect:/login');
  });

  it('turns away an operator', async () => {
    // Operators may not reach the admin console at all (spec/admin.md §14.3),
    // and this page lists every attendee in the concert.
    sessionUser.mockResolvedValue({
      id: randomUUID(), email: 'o@x', displayName: 'Wei', role: 'OPERATOR',
    });
    expect(await outcome(() => render(concertId))).not.toBe('allowed');
  });

  it('404s on a concert that does not exist', async () => {
    expect(await outcome(() => render(999_999))).toBe('notFound');
    expect(await outcome(() => render(-1))).toBe('notFound');
  });
});
