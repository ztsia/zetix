import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
} from '../helpers/fixtures';

/**
 * Home (spec/v3.md §29.2), which replaced the concert overview.
 *
 * The screen that answers "what needs me, and is this concert configured?"
 * without opening anything, so what is tested is that it renders in every
 * half-configured state it exists to describe — including the ones where the
 * allocation engine refuses to produce numbers and no ticket design exists.
 * The checklist's rules themselves are tested without a database in
 * `tests/lib/home-checklist.test.ts`.
 */

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  usePathname: () => '/',
  useRouter: () => ({}),
}));

const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'ana@example.test', displayName: 'Ana', role: 'ADMIN' };
const VIEWER = { id: '00000000-0000-4000-8000-0000000000bb', email: 'mei@example.test', displayName: 'Mei', role: 'VIEWER' };
const sessionUser = vi.fn(async () => ADMIN as typeof ADMIN | typeof VIEWER);
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const HomePage = (await import('@/app/(admin)/admin/concerts/[concertId]/home/page')).default;

const render = (concertId: number | string) =>
  HomePage({ params: Promise.resolve({ concertId: String(concertId) }) });

describe('Home', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    sessionUser.mockImplementation(async () => ADMIN);
    concertId = await createConcert('September concert');
  });

  it('renders a concert with nothing configured at all', async () => {
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders a show whose hall has no capacity', async () => {
    await createShow(concertId, null);
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders a segment with no capacity, where the engine has no pool to give', async () => {
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders the fully configured 19 Sep shape', async () => {
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
    });

    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('cannot be pushed over the hall in the first place', async () => {
    // `assert_segments_fit_hall` refuses Σ segment capacity > hall with no
    // override flag, so "N over" is a state the database will not produce. The
    // page renders it defensively anyway; what is worth asserting is the
    // refusal, and that the numbers on screen stay the ones that were valid.
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
    });

    await expect(
      sql`update shows set capacity = 350 where id = ${showId}::bigint`,
    ).rejects.toThrow(/the hall holds 350/);

    const [row] = await sql<{ capacity: number }[]>`
      select capacity from shows where id = ${showId}::bigint
    `;
    expect(row.capacity).toBe(400);
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('404s on a concert that does not exist', async () => {
    await expect(render(999999)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s on a non-numeric id instead of querying with NaN', async () => {
    await expect(render('not-a-number')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s on a soft-deleted concert', async () => {
    await sql`update concerts set deleted_at = now() where id = ${concertId}::bigint`;
    await expect(render(concertId)).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

// ---------------------------------------------------------------------------
// What Home shows, not only that it renders. A QA probe zeroed every tile and
// removed the heartbeat's mask, and the render-only tests above stayed green.
// ---------------------------------------------------------------------------

/** Every node in a rendered tree that satisfies `test`. Element props are walked like any object. */
function findAll(node: unknown, test: (n: Record<string, unknown>) => boolean, seen = new WeakSet<object>(), out: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (node instanceof Date) return out;
  if (!Array.isArray(node) && test(node as Record<string, unknown>)) out.push(node as Record<string, unknown>);
  for (const value of Array.isArray(node) ? node : Object.values(node)) findAll(value, test, seen, out);
  return out;
}

/** Every string and number under a node, for reading what a link says. */
function texts(node: unknown, seen = new WeakSet<object>(), out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node));
  else if (node && typeof node === 'object' && !seen.has(node) && !(node instanceof Date)) {
    seen.add(node);
    for (const value of Array.isArray(node) ? node : Object.values(node)) texts(value, seen, out);
  }
  return out;
}

const props = (node: Record<string, unknown>) => (node.props ?? {}) as Record<string, unknown>;
const linksTo = (tree: unknown, href: string) => findAll(tree, (n) => props(n).href === href);
const propOf = (tree: unknown, key: string) => findAll(tree, (n) => key in props(n)).map((n) => props(n)[key]);

describe('Home, read', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    sessionUser.mockImplementation(async () => ADMIN);
    concertId = await createConcert('Read concert');
    showId = await createShow(concertId, 100);
    segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  });

  it('links each non-zero count to the view that holds it, and leaves zeros out', async () => {
    for (const name of ['A', 'B']) {
      const id = await createRegistration({ showId, segmentId, contactName: name });
      // A stage needs a live seat; a party with none has none (`party_pipeline`).
      await seedAttendees({ registrationId: id, showId, segmentId, count: 1, allocationType: 'EXTRA' });
      await sql`update registrations set approved_at = null where id = ${id}`;
    }
    const tree = await render(concertId);
    const base = `/admin/concerts/${concertId}`;

    const review = linksTo(tree, `${base}/audience?view=needs-review`);
    // Two links go there: the funnel's stage tile, and the attention tile,
    // which is the one that says what to do next.
    const tile = review.find((link) => texts(link).some((t) => t.startsWith('Approve')));
    expect(tile, 'a Needs review tile in Needs attention').toBeDefined();
    expect(texts(tile)).toContain('2');
    expect(texts(tree).join(' ')).not.toContain('Nothing is waiting on a person right now.');
    // Nothing bounced, so no Bounced tile to open.
    const bouncedTiles = linksTo(tree, `${base}/audience?view=bounced`);
    expect(bouncedTiles).toEqual([]);

    const [views] = propOf(tree, 'views') as Record<string, number>[];
    expect(views!['needs-review']).toBe(2);
  });

  it('says nothing needs a person when nothing does', async () => {
    const tree = await render(concertId);
    expect(texts(tree).join(' ')).toContain('Nothing is waiting on a person right now.');
  });

  it('warns about a late scheduler, and says so rather than warning when it is not set up', async () => {
    const stateOf = async () => (propOf(await render(concertId), 'state')[0] as { kind: string }).kind;

    await sql`delete from system_settings where key = 'scheduler.tick_minutes'`;
    expect(await stateOf()).toBe('unscheduled');

    await setSystemSetting('scheduler.tick_minutes', 5);
    expect(await stateOf()).toBe('never');

    await sql`insert into scheduler_heartbeat (source, started_at) values ('cron', now() - interval '16 minutes')`;
    expect(await stateOf()).toBe('stale');

    await sql`insert into scheduler_heartbeat (source, started_at) values ('cron', now() - interval '1 minute')`;
    expect(await stateOf()).toBe('ok');
  });

  it('masks what a viewer is handed: the heartbeat error, an import filename, a form title', async () => {
    await setSystemSetting('scheduler.tick_minutes', 5);
    await sql`insert into scheduler_heartbeat (source, started_at, error)
              values ('cron', now(), 'dispatch: 550 no such user tick.secret@example.test')`;
    const [batch] = await sql<{ id: string }[]>`
      insert into import_batches (show_id, segment_id, filename, status, report)
      values (${showId}, ${segmentId}, 'from-file.secret@example.test.csv', 'STAGED', '{}'::jsonb) returning id`;
    await sql`insert into import_rows (batch_id, row_number, seat_index, raw, normalized, issues, status, party_key)
              values (${batch!.id}, 2, 0, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'STAGED', 'k')`;
    await sql`insert into registration_forms (segment_id, title, slug, status, kind, closes_at)
              values (${segmentId}, 'Ask form.secret@example.test', 'ask', 'OPEN', 'PUBLIC', now() + interval '2 days')`;
    const secrets = ['tick.secret@example.test', 'from-file.secret@example.test', 'form.secret@example.test'];

    sessionUser.mockImplementation(async () => ADMIN);
    const admin = texts(await render(concertId)).join('\n');
    for (const secret of secrets) expect(admin, `admin sees ${secret}`).toContain(secret);

    sessionUser.mockImplementation(async () => VIEWER);
    const viewer = texts(await render(concertId)).join('\n');
    for (const secret of secrets) expect(viewer, `viewer must not see ${secret}`).not.toContain(secret);
  });
});
