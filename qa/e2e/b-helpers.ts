import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import postgres from 'postgres';

export const QA_URL =
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';

/**
 * One client per spec file. A single shared one breaks under `workers: 1`,
 * where all three files run in the same worker process: the first file's
 * `afterAll` ends it and the next file's queries fail with CONNECTION_ENDED.
 */
export const newSql = () => postgres(QA_URL, { prepare: false, max: 2 });

export const SHOTS = 'qa-artifacts/B-registrations-extras/screens';

/**
 * The ids `qa/support/start-b.sh` seeds. Every spec here assumes that script
 * has just run.
 *
 * **Do not call `reseed()` while the dev server is up.** It truncates
 * `concerts`/`shows`/`show_segments`, and the running `next dev` then answers
 * the concert layout's lookup with zero rows for the rest of its life, so every
 * `/admin/concerts/{id}/*` page 404s until the server restarts.
 */
export const SEEDED_IDS: Record<string, string> = {
  concertId: '1', show1: '1', show2: '2',
  publicSegment: '1', playerSegment: '2', matineeSegment: '3',
};

/** Re-run module B's seed. Only safe before the dev server starts. */
export function reseed(): Record<string, string> {
  const out = execFileSync('node', ['qa/support/seed-b.mjs'], {
    env: { ...process.env, QA_DATABASE_URL: QA_URL, QA_ADMIN_EMAIL: 'committee@example.test' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

export async function asAdmin(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/**
 * Reset just the player segment's review queue.
 *
 * Deliberately **not** `reseed()`: truncating `concerts`/`shows`/`show_segments`
 * underneath a running `next dev` leaves its cached postgres client answering
 * the concert layout's lookup with zero rows for the rest of the process, and
 * every `/admin/concerts/{id}/*` page then 404s until the server restarts. That
 * is a harness artifact, but it makes a mid-run reseed unusable. This touches
 * only the rows the review flows own.
 */
export async function resetReviewQueue(sql: ReturnType<typeof newSql>, ids: Record<string, string>) {
  await sql`delete from email_outbox`;
  await sql`delete from attendees where segment_id = ${ids.playerSegment}`;
  await sql`delete from registrations where segment_id = ${ids.playerSegment}`;
  // Capacity first, then the players: §7.4's guard refuses reactivating a
  // player into a segment too small for the entitlement that creates, which is
  // decision 17 covering the third of its three mutation routes.
  await sql`update show_segments set capacity = 100, allow_partial_grant = false
             where id = ${ids.playerSegment}`;
  await sql`update players set is_active = true`;

  const players = await sql<{ id: string; full_name: string }[]>`
    select id, full_name from players order by id limit 4`;
  const parties: [string, number][] = [
    ['2026-09-10T01:00:00Z', 2],
    ['2026-09-10T02:30:00Z', 1],
    ['2026-09-11T09:15:00Z', 3],
    ['2026-09-12T04:45:00Z', 1],
  ];
  for (const [i, [at, extras]] of parties.entries()) {
    const [r] = await sql<{ id: string }[]>`
      insert into registrations (show_id, segment_id, player_id, source, contact_name,
                                 contact_email, status, requested_at, round_label)
      values (${ids.show1}, ${ids.playerSegment}, ${players[i].id}, 'IMPORT',
              ${players[i].full_name}, ${'player' + (i + 1) + '@example.test'},
              'WAITLIST', ${at}, 'Round 1')
      returning id`;
    const seats = [
      { full_name: players[i].full_name, email: null, allocation_type: 'BASE' },
      ...Array.from({ length: extras }, (_, n) => ({
        full_name: `Guest ${n + 1} of ${players[i].full_name}`,
        email: null,
        allocation_type: 'EXTRA',
      })),
    ];
    await sql`select claim_seats(${ids.playerSegment}::bigint, ${r.id}::bigint,
      ${JSON.stringify(seats)}::text::jsonb, false)`;
    await sql`update registrations r set status = case
        when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'CONFIRMED') then 'CONFIRMED'
        when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'PENDING_REVIEW') then 'PENDING_REVIEW'
        else 'WAITLIST' end::booking_status
      where r.id = ${r.id}`;
  }
}
