import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';

/**
 * Do the routes still **call** their guards?
 *
 * The guard functions are well covered elsewhere. That is a different claim from
 * "every protected route invokes one", and an independent QA pass showed the
 * gap: deleting the assignment check from `/scan/[showId]`, and deleting
 * `requireAdmin()` from the admin layout, both left the suite 200/200 green.
 * Two routes stopped being protected and nothing said so.
 *
 * These call the real route modules with the real guards and the real database.
 * Only `getSessionUser` is stubbed — it is the one leaf that needs Supabase, and
 * there is no service-role key in a cloud container to make users with
 * (spec/local.md §7). Everything the routes do with the answer is genuine.
 *
 * `redirect()` and `notFound()` work by throwing, so a guard firing *is* the
 * exception. A route that returns instead of throwing has let the caller in.
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

const ScannerShowPage = (await import('@/app/(scanner)/scan/(app)/[showId]/page')).default;
const ScannerHomePage = (await import('@/app/(scanner)/scan/(app)/page')).default;
const AdminLayout = (await import('@/app/(admin)/admin/layout')).default;
const FormPreviewPage = (await import('@/app/(registration)/preview/[formId]/page')).default;

/** What the route did: `allowed`, or the guard signal it threw. */
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

async function makeUser(role: 'ADMIN' | 'OPERATOR' | 'VIEWER'): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`${role}-${id}@example.test`}, ${role}, ${role}::user_role)
  `;
  return id;
}

const showPage = (id: number) => ScannerShowPage({ params: Promise.resolve({ showId: String(id) }) });

let assignedShow: number;
let otherShow: number;
let operator: string;
let admin: string;
let viewer: string;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();

  const concertId = await createConcert();
  assignedShow = await createShow(concertId, 100);
  otherShow = await createShow(concertId, 100);
  operator = await makeUser('OPERATOR');
  admin = await makeUser('ADMIN');
  viewer = await makeUser('VIEWER');
  await sql`
    insert into operator_show_assignments (user_id, show_id)
    values (${operator}::uuid, ${assignedShow})
  `;
});

const asOperator = () =>
  sessionUser.mockResolvedValue({ id: operator, email: 'o@x', displayName: 'Wei', role: 'OPERATOR' });
const asAdmin = () =>
  sessionUser.mockResolvedValue({ id: admin, email: 'a@x', displayName: 'Committee', role: 'ADMIN' });
const asViewer = () =>
  sessionUser.mockResolvedValue({ id: viewer, email: 'v@x', displayName: 'Mei', role: 'VIEWER' });
const anonymous = () => sessionUser.mockResolvedValue(null);

describe('/scan/[showId] enforces assignment', () => {
  it('admits an operator to a show they are rostered on', async () => {
    asOperator();
    expect(await outcome(() => showPage(assignedShow))).toBe('allowed');
  });

  it('refuses an operator a show they are not rostered on', async () => {
    // The probe that stayed green: deleting this check from the route hands one
    // usher every show's attendee roster.
    asOperator();
    expect(await outcome(() => showPage(otherShow))).toBe('notFound');
  });

  it('is a 404, not a 403 — an unassigned show is indistinguishable from no show', async () => {
    asOperator();
    expect(await outcome(() => showPage(999_999))).toBe('notFound');
    expect(await outcome(() => showPage(otherShow))).toBe('notFound');
  });

  it('sends a VIEWER back to the console — reading is not admitting', async () => {
    asViewer();
    expect(await outcome(() => showPage(assignedShow))).toBe('redirect:/admin');
  });

  it('sends an anonymous visitor to the scanner login before touching the show', async () => {
    anonymous();
    expect(await outcome(() => showPage(assignedShow))).toBe('redirect:/scan/login');
  });

  it('lets an ADMIN into any show', async () => {
    asAdmin();
    expect(await outcome(() => showPage(otherShow))).toBe('allowed');
  });
});

describe('/scan lists only what the operator may reach', () => {
  it('auto-selects the sole assignment (spec/checkin.md §12.1)', async () => {
    // Choosing from a list of one is where an usher admits against the wrong
    // show; the spec removes the choice.
    asOperator();
    expect(await outcome(ScannerHomePage)).toBe(`redirect:/scan/${assignedShow}`);
  });

  it('shows the empty state for a provisioned-but-not-rostered account', async () => {
    await sql`delete from operator_show_assignments where user_id = ${operator}::uuid`;
    asOperator();
    expect(await outcome(ScannerHomePage)).toBe('allowed');
  });

  it('never auto-selects for an ADMIN, who moves between shows', async () => {
    await sql`delete from operator_show_assignments`;
    await sql`delete from shows where id = ${otherShow}`;
    asAdmin();
    expect(await outcome(ScannerHomePage)).toBe('allowed');
  });

  it('sends an anonymous visitor to the scanner login', async () => {
    anonymous();
    expect(await outcome(ScannerHomePage)).toBe('redirect:/scan/login');
  });
});

describe('the admin layout is the console boundary', () => {
  const render = () => AdminLayout({ children: null });

  it('admits an admin', async () => {
    asAdmin();
    expect(await outcome(render)).toBe('allowed');
  });

  it('admits a VIEWER — they read every admin screen (spec/v3.md §28)', async () => {
    asViewer();
    expect(await outcome(render)).toBe('allowed');
  });

  it('refuses an OPERATOR', async () => {
    // The probe that stayed green: without this, an usher reaches every
    // attendee's name and email.
    asOperator();
    expect(await outcome(render)).toBe('redirect:/scan');
  });

  it('sends a signed-out visitor to the admin login', async () => {
    anonymous();
    expect(await outcome(render)).toBe('redirect:/login');
  });
});

describe('/preview/[formId] is console-only, though it sits on the public surface', () => {
  /**
   * The one admin screen outside `/admin`, so neither the admin layout nor
   * `proxy.ts` covers it: `requireRole()` in the page is the whole guard. It
   * reaches a draft form by a guessable id with none of `/f/{slug}`'s gates
   * (spec/v2.md §8.2.2b). A QA probe deleted that call and the suite stayed
   * green; these are what now go red.
   */
  const render = (id = 999_999) => FormPreviewPage({ params: Promise.resolve({ formId: String(id) }) });

  it('sends a signed-out visitor to the admin login', async () => {
    anonymous();
    expect(await outcome(render)).toBe('redirect:/login');
  });

  it('refuses an OPERATOR', async () => {
    asOperator();
    expect(await outcome(render)).toBe('redirect:/scan');
  });

  it('lets a VIEWER through too — a preview submits nothing', async () => {
    asViewer();
    expect(await outcome(render)).toBe('notFound');
  });

  it('lets an admin through to the form lookup', async () => {
    // Past the guard, an id with no form behind it is a 404 — which is how
    // this proves the guard let the admin in.
    asAdmin();
    expect(await outcome(render)).toBe('notFound');
  });
});
