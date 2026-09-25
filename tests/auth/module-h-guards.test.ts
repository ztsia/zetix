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
 * Do module `H`'s pages and Server Actions still **call** their guards?
 *
 * The guards themselves are covered elsewhere; that is a different claim from
 * "every entry point invokes one". This file exists because of what the QA pass
 * on module `G` found: a suite can be entirely green while the thing it names is
 * not actually exercised. A Server Action is its own POST entry point, so the
 * page's `requireAdmin()` protects nothing about it — deleting the guard from
 * any action below must turn this file red.
 *
 * It matters most here. These actions create Supabase Auth users, hand out the
 * credential that reaches an attendee roster, and rewrite the record of who was
 * admitted.
 *
 * Only `getSessionUser` is stubbed — the one leaf that needs Supabase, which no
 * cloud container can reach (spec/local.md §7). The guards, the database and the
 * actions are all real.
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

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

/**
 * The service-role client is unreachable here and must never be the reason a
 * guard test passes: without this, "no service-role key" and "refused for the
 * right reason" would be indistinguishable.
 */
vi.mock('@/lib/operators/auth-admin', () => ({
  createOperatorAuthAdmin: () => ({
    async createUser() {
      return { id: '00000000-0000-4000-8000-0000000009ff' };
    },
    async updatePassword() {},
    async deleteUser() {},
  }),
}));

const OperatorsPage = (await import('@/app/(admin)/admin/concerts/[concertId]/operators/page'))
  .default;
const CheckinPage = (await import('@/app/(admin)/admin/concerts/[concertId]/checkin/page'))
  .default;
const {
  createOperatorAction,
  regenerateAccessCodeAction,
  setOperatorActiveAction,
  setShowAssignmentsAction,
} = await import('@/app/(admin)/admin/concerts/[concertId]/operators/actions');
const { revertCheckInAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/checkin/actions'
);

const ADMIN = {
  id: '00000000-0000-4000-8000-0000000000aa',
  email: 'admin@example.test',
  displayName: 'Committee',
  role: 'ADMIN' as const,
};
const VIEWER = {
  id: '00000000-0000-4000-8000-0000000000bb',
  email: 'viewer@example.test',
  displayName: 'Mei',
  role: 'VIEWER' as const,
};
const OPERATOR = {
  id: '00000000-0000-4000-8000-000000000101',
  email: 'wei@operators.invalid',
  displayName: 'Wei',
  role: 'OPERATOR' as const,
};

/** What the entry point did: `allowed`, or the guard signal it threw. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    if (error instanceof NotFoundSignal) return 'notFound';
    if (error instanceof Error && error.name === 'ReadOnlyAccountError') return 'read-only';
    throw error;
  }
}

let concertId: number;
let showId: number;
let checkInId: number;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();

  await sql`
    insert into app_users (id, email, display_name, role, is_active) values
      (${ADMIN.id}, ${ADMIN.email}, 'Committee', 'ADMIN', true),
      (${VIEWER.id}, ${VIEWER.email}, 'Mei', 'VIEWER', true),
      (${OPERATOR.id}, ${OPERATOR.email}, 'Wei', 'OPERATOR', true)
  `;

  concertId = await createConcert('Guarded Concert');
  showId = await createShow(concertId, 300);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count: 1,
    allocationType: 'BASE',
    status: 'CONFIRMED',
  });

  const [attendee] = await sql<{ id: number }[]>`
    select id from attendees where show_id = ${showId} limit 1
  `;
  const [scan] = await sql<{ id: number }[]>`
    insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
    values (${attendee!.id}, ${showId}, ${OPERATOR.id}, 'phone-1', now(), now(), 'ONLINE')
    returning id
  `;
  checkInId = Number(scan!.id);
});

describe('the pages are behind requireRole()', () => {
  const pages = [
    ['operators', () => OperatorsPage({ params: Promise.resolve({ concertId: String(concertId) }) })],
    [
      'checkin',
      () =>
        CheckinPage({
          params: Promise.resolve({ concertId: String(concertId) }),
          searchParams: Promise.resolve({}),
        }),
    ],
  ] as const;

  for (const [name, render] of pages) {
    it(`${name}: signed out lands on the admin login`, async () => {
      sessionUser.mockResolvedValue(null);
      expect(await outcome(render)).toBe('redirect:/login');
    });

    it(`${name}: an operator is bounced to the scanner`, async () => {
      sessionUser.mockResolvedValue(OPERATOR);
      expect(await outcome(render)).toBe('redirect:/scan');
    });

    it(`${name}: the admin gets in`, async () => {
      sessionUser.mockResolvedValue(ADMIN);
      expect(await outcome(render)).toBe('allowed');
    });

    it(`${name}: a viewer reads it (spec/v3.md §28)`, async () => {
      sessionUser.mockResolvedValue(VIEWER);
      expect(await outcome(render)).toBe('allowed');
    });
  }
});

describe('every operator action calls its guard', () => {
  function createForm() {
    const form = new FormData();
    form.set('displayName', 'New Usher');
    form.set('concertId', String(concertId));
    return form;
  }

  const actions = () =>
    [
      ['create', () => createOperatorAction({ error: null }, createForm())],
      ['regenerate', () => regenerateAccessCodeAction(OPERATOR.id, concertId)],
      ['deactivate', () => setOperatorActiveAction(OPERATOR.id, false, concertId)],
      ['assign', () => setShowAssignmentsAction(OPERATOR.id, concertId, [showId])],
    ] as const;

  it('refuses a signed-out caller', async () => {
    sessionUser.mockResolvedValue(null);
    for (const [name, run] of actions()) {
      expect(await outcome(run), name).toBe('redirect:/login');
    }
  });

  it('refuses an operator — provisioning is not theirs to do', async () => {
    sessionUser.mockResolvedValue(OPERATOR);
    for (const [name, run] of actions()) {
      expect(await outcome(run), name).toBe('redirect:/scan');
    }
  });

  it('refuses a viewer — read-only means no provisioning (spec/v3.md §28)', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    for (const [name, run] of actions()) {
      expect(await outcome(run), name).toBe('read-only');
    }
  });

  it('leaves nothing behind when it refuses', async () => {
    sessionUser.mockResolvedValue(OPERATOR);
    for (const [, run] of actions()) await outcome(run);
    sessionUser.mockResolvedValue(VIEWER);
    for (const [, run] of actions()) await outcome(run);

    const users = await sql`select count(*)::int as n from app_users where role = 'OPERATOR'`;
    const assignments = await sql`select count(*)::int as n from operator_show_assignments`;
    expect(users[0]!.n).toBe(1);
    expect(assignments[0]!.n).toBe(0);
  });
});

describe('revertCheckInAction calls its guard', () => {
  const revert = () => revertCheckInAction({ checkInId, showId, concertId });

  it('refuses a signed-out caller', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(revert)).toBe('redirect:/login');
  });

  it('refuses an operator: admitting is theirs, unwriting the record is not', async () => {
    sessionUser.mockResolvedValue(OPERATOR);
    expect(await outcome(revert)).toBe('redirect:/scan');

    const rows = await sql`select reverted_at from check_ins where id = ${checkInId}`;
    expect(rows[0]!.reverted_at).toBeNull();
  });

  it('refuses a viewer, and the scan stays admitted', async () => {
    sessionUser.mockResolvedValue(VIEWER);
    expect(await outcome(revert)).toBe('read-only');

    const rows = await sql`select reverted_at from check_ins where id = ${checkInId}`;
    expect(rows[0]!.reverted_at).toBeNull();
  });

  it('lets the admin through', async () => {
    sessionUser.mockResolvedValue(ADMIN);
    const result = await revertCheckInAction({ checkInId, showId, concertId });
    expect(result.error).toBeNull();

    const rows = await sql`select reverted_at, reverted_by from check_ins where id = ${checkInId}`;
    expect(rows[0]!.reverted_at).not.toBeNull();
    expect(rows[0]!.reverted_by).toBe(ADMIN.id);
  });

  it('refuses a scan from a show the admin did not open', async () => {
    sessionUser.mockResolvedValue(ADMIN);
    const otherShowId = await createShow(concertId, 300);

    const result = await revertCheckInAction({ checkInId, showId: otherShowId, concertId });
    expect(result.error).not.toBeNull();

    const rows = await sql`select reverted_at from check_ins where id = ${checkInId}`;
    expect(rows[0]!.reverted_at).toBeNull();
  });
});
