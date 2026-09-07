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
 * Do the ticket Server Actions **call** `requireAdmin()`?
 *
 * An independent QA pass found they were untested: making both guards
 * unreachable left the suite 466/466 green. That is the same class
 * `tests/auth/route-guards.test.ts` exists for after F2's own QA pass — `D`
 * added two Server Actions and did not extend it.
 *
 * It matters because a Server Action is its **own entry point**. The page's
 * guard does not cover it, `src/proxy.ts` never reads a role, and these two
 * actions mint identifiers, pin templates and clear `ticket_sent_at` — the last
 * of which puts a party back in the queue for another email.
 *
 * Only `getSessionUser` is stubbed; the guards, the database and the ticket
 * layer are all real.
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
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { issueTicketsAction, reissueTicketsAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/tickets/actions'
);

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    return `threw:${(error as Error).message}`;
  }
}

let concertId: number;
let showId: number;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Actions');
  showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 3, allocationType: 'BASE',
  });
});

const asAdmin = async () => {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`a-${id}@example.test`}, 'Committee', 'ADMIN')
  `;
  sessionUser.mockResolvedValue({ id, email: 'a@x', displayName: 'Committee', role: 'ADMIN' });
};
const asOperator = async () => {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`o-${id}@example.test`}, 'Wei', 'OPERATOR')
  `;
  sessionUser.mockResolvedValue({ id, email: 'o@x', displayName: 'Wei', role: 'OPERATOR' });
};

const issued = async () => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where show_id = ${showId} and ticket_template_id is not null
  `;
  return row.n;
};

describe('issueTicketsAction', () => {
  it('issues for an admin', async () => {
    await asAdmin();
    const result = await issueTicketsAction({ concertId, showId });
    expect(result.ok).toBe(true);
    expect(await issued()).toBe(3);
  });

  it('turns away an operator, and issues nothing', async () => {
    // The probe that stayed green: without the guard, any signed-in operator
    // can mint identifiers for a whole show.
    await asOperator();
    expect(await outcome(() => issueTicketsAction({ concertId, showId }))).not.toBe('allowed');
    expect(await issued()).toBe(0);
  });

  it('turns away an anonymous caller, and issues nothing', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => issueTicketsAction({ concertId, showId }))).not.toBe('allowed');
    expect(await issued()).toBe(0);
  });

  it('rejects a malformed scope rather than widening it', async () => {
    await asAdmin();
    const result = await issueTicketsAction({ concertId: -1 } as never);
    expect(result.ok).toBe(false);
    expect(await issued()).toBe(0);
  });
});

describe('reissueTicketsAction', () => {
  beforeEach(async () => {
    await asAdmin();
    await issueTicketsAction({ concertId, showId });
    await sql`update attendees set ticket_sent_at = now() where show_id = ${showId}`;
    sessionUser.mockReset();
  });

  const stillSent = async () => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where show_id = ${showId} and ticket_sent_at is not null
    `;
    return row.n;
  };

  it('reissues for an admin', async () => {
    await asAdmin();
    const result = await reissueTicketsAction({ concertId, showId });
    expect(result.ok).toBe(true);
    // Clearing the stamp is what queues the resend (spec/email.md §11.4).
    expect(await stillSent()).toBe(0);
  });

  it('turns away an operator, and resends nothing', async () => {
    // Worse than the issue path: without the guard an operator could clear
    // `ticket_sent_at` for a whole show and trigger a second blast to everyone.
    await asOperator();
    expect(await outcome(() => reissueTicketsAction({ concertId, showId }))).not.toBe('allowed');
    expect(await stillSent()).toBe(3);
  });

  it('turns away an anonymous caller, and resends nothing', async () => {
    sessionUser.mockResolvedValue(null);
    expect(await outcome(() => reissueTicketsAction({ concertId, showId }))).not.toBe('allowed');
    expect(await stillSent()).toBe(3);
  });
});
