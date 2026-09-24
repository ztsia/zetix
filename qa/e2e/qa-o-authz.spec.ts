import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module `O` — the authorization matrix and the hostile-input boundary.
 *
 * Every cell is filled by making the call. The notes surfaces are the two that
 * matter: the grouped view is admin-only *always* (`admin.md` §14.2,
 * decision 6) and the export route is that view in a spreadsheet, carrying the
 * real name of every writer who asked the wall not to show it.
 */
const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/O-notes-wall/screens';
const NOTES_URL = '/admin/concerts/1/notes';

/** Text that must never appear in a response the caller was not entitled to. */
const SECRETS = [
  'The Sibelius was extraordinary tonight.',
  'Ada, your solo was the evening.',
  'Writer Two',
  'Ada Lim',
];

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

async function loginOperator(page: Page) {
  await page.goto('/scan/login');
  await page.fill('input[name="displayName"]', 'Usher');
  await page.fill('input[name="code"]', 'qa-op-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  // `/scan/login` itself matches `/scan`, so waiting on that reads the cookie
  // jar before the session exists and every later call looks anonymous.
  await page.waitForURL(/\/scan\/\d+/);
}

const cookieHeader = async (page: Page) =>
  (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.afterAll(async () => { await sql.end(); });

test('FLOW-18 anonymous is refused the notes screen and the export route', async ({ page, request }) => {
  await page.goto(NOTES_URL);
  await page.waitForLoadState('networkidle');
  expect(page.url()).toContain('/login');
  for (const secret of SECRETS) expect(await page.content()).not.toContain(secret);
  await shot(page, 'FLOW-18-step-1-anon-redirected');

  const csv = await request.get('/api/notes/export?concertId=1');
  expect(csv.status()).toBe(401);
  expect(await csv.text()).toBe('{"error":"Not signed in"}');
  await shot(page, 'FLOW-18-step-2-anon-export-401');
});

test('FLOW-17 an assigned operator is refused the screen, the export and every action', async ({ page }) => {
  await loginOperator(page);
  await shot(page, 'FLOW-17-step-1-operator-signed-in');

  // The operator really is assigned to this concert's show.
  const [assigned] = await sql<{ n: number }[]>`
    select count(*)::int as n from operator_show_assignments
     where user_id = '22222222-2222-4222-8222-222222222222'::uuid and show_id = 1`;
  expect(assigned.n).toBe(1);

  const before = await sql<{ id: string; moderation_status: string; wall_status: string }[]>`
    select id, moderation_status, wall_status from portal_notes order by id`;

  await page.goto(NOTES_URL);
  await page.waitForLoadState('networkidle');
  /**
   * **The screen is refused; the shape of the refusal is not this module's.**
   * `requireAdmin()` redirects an operator to `/scan`, and what actually
   * reaches the browser here is a 404 at the same URL. That is app-wide
   * behaviour of `F2`'s guard, not `O`'s — `/admin/concerts/1/portal`, which
   * `N` shipped and QA'd, does exactly the same thing for the same session.
   * Worth someone's attention (the branch handoff records it), but asserting
   * a redirect here would make this module's suite fail for another module's
   * behaviour.
   *
   * What matters, and is asserted: nothing rendered, and no note reached the
   * page.
   */
  const refused = await page.content();
  expect(refused).toContain('could not be found');
  for (const secret of SECRETS) expect(refused).not.toContain(secret);
  await shot(page, 'FLOW-17-step-2-refused-the-screen');

  // The export route is outside the proxy matcher, so it is its own boundary.
  const header = await cookieHeader(page);
  const csv = await page.request.get('/api/notes/export?concertId=1', { headers: { cookie: header } });
  expect(csv.status()).toBe(403);
  expect(await csv.text()).toBe('{"error":"Admins only"}');
  await shot(page, 'FLOW-17-step-3-export-403');

  // Nothing in the database moved.
  const after = await sql<{ id: string; moderation_status: string; wall_status: string }[]>`
    select id, moderation_status, wall_status from portal_notes order by id`;
  expect(after).toEqual(before);
});

test('BE-1 the export route rejects hostile input without a stack trace', async ({ page }) => {
  await loginAdmin(page);
  const header = { cookie: await cookieHeader(page) };

  const cases: { name: string; url: string; expect: number }[] = [
    { name: 'no concertId', url: '/api/notes/export', expect: 400 },
    { name: 'concertId not a number', url: '/api/notes/export?concertId=abc', expect: 400 },
    { name: 'concertId negative', url: '/api/notes/export?concertId=-1', expect: 400 },
    { name: 'concertId zero', url: '/api/notes/export?concertId=0', expect: 400 },
    { name: 'concertId fractional', url: '/api/notes/export?concertId=1.5', expect: 400 },
    { name: 'concertId out of range', url: '/api/notes/export?concertId=999999', expect: 404 },
    {
      name: 'SQL metacharacters in concertId',
      url: `/api/notes/export?concertId=${encodeURIComponent("1; drop table portal_notes --")}`,
      expect: 400,
    },
    {
      name: 'path traversal in playerIds',
      url: `/api/notes/export?concertId=1&playerIds=${encodeURIComponent('../../etc/passwd')}`,
      expect: 200,
    },
    {
      name: 'SQL metacharacters in playerIds',
      url: `/api/notes/export?concertId=1&playerIds=${encodeURIComponent("2') or 1=1 --")}`,
      expect: 200,
    },
    {
      name: 'very long playerIds',
      url: `/api/notes/export?concertId=1&playerIds=${Array.from({ length: 2000 }, (_, i) => i).join(',')}`,
      expect: 200,
    },
  ];

  const seen: string[] = [];
  for (const c of cases) {
    const response = await page.request.get(c.url, { headers: header });
    const body = await response.text();
    seen.push(`${c.name}: ${response.status()} ${body.slice(0, 120).replace(/\n/g, ' ')}`);
    expect(response.status(), c.name).toBe(c.expect);
    // No stack trace, ever.
    expect(body, c.name).not.toContain('at Object.');
    expect(body, c.name).not.toContain('node_modules');
    expect(body, c.name).not.toMatch(/PostgresError|syntax error at or near/);
  }
  console.log(seen.join('\n'));

  // The table is still there.
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from portal_notes`;
  expect(n).toBeGreaterThan(0);

  await page.goto(NOTES_URL);
  await shot(page, 'BE-1-step-1-screen-intact-after-hostile-input');
});

/**
 * FINDING: a `concertId` past `Number.MAX_SAFE_INTEGER` survives
 * `Number.isInteger()` as `1e+40`, reaches Postgres as a bigint parameter and
 * throws `22P02`, which nothing catches. Expected a structured 400.
 */
test('BE-1b a concertId past the safe integer range returns 500, not a structured error', async ({ page }) => {
  await loginAdmin(page);
  const header = { cookie: await cookieHeader(page) };
  const response = await page.request.get(
    `/api/notes/export?concertId=${'9'.repeat(40)}`, { headers: header },
  );
  console.log('huge concertId ->', response.status());
  expect(response.status()).toBe(400);
});

test('BE-2 an unparseable playerIds list exports everything, not nothing', async ({ page }) => {
  await loginAdmin(page);
  const header = { cookie: await cookieHeader(page) };
  const all = await (await page.request.get('/api/notes/export?concertId=1', { headers: header })).text();
  const junk = await (await page.request.get(
    `/api/notes/export?concertId=1&playerIds=${encodeURIComponent('../../etc/passwd')}`,
    { headers: header },
  )).text();
  // Documented behaviour in the route: an unparseable list reads as absent.
  expect(junk).toBe(all);
  expect(junk).not.toContain('root:');
});

test('BE-3 concurrent submits by one attendee produce exactly one note and no 500', async ({ browser }) => {
  const token = 'WriterOneFFFFFFFFFF6xx';
  await sql`delete from portal_notes n using attendees a
             where a.id = n.attendee_id and a.qr_token = ${token}`;

  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await Promise.all(pages.map((p) => p.goto(`/t/${token}`)));
  await Promise.all(pages.map((p, i) => p.getByLabel('Your note').fill(`Racing note ${i}`)));

  const results = await Promise.all(
    pages.map((p) => p.getByRole('button', { name: /send my note/i }).click().then(
      () => p.getByText('Your note has been sent').waitFor({ timeout: 10_000 }).then(() => 'ok'),
      (e) => String(e),
    )),
  );
  console.log('concurrent results:', results);

  const rows = await sql<{ id: string; body: string }[]>`
    select n.id, n.body from portal_notes n join attendees a on a.id = n.attendee_id
     where a.qr_token = ${token}`;
  expect(rows).toHaveLength(1);
  for (const p of pages) expect(await p.content()).not.toContain('Application error');
  await pages[0].screenshot({ path: `${SHOTS}/BE-3-step-1-one-note-after-race.png`, fullPage: true });
  for (const c of contexts) await c.close();

  // Put the seed's note back so later runs see the same wall.
  await sql`update portal_notes set body = 'The Sibelius was extraordinary tonight.',
                   display_name = 'Writer One', moderation_status = 'APPROVED',
                   wall_status = 'PUBLISHED'
             where id = ${Number(rows[0].id)}`;
});

/**
 * **Rewritten after the defect it found was fixed.** As written, this recorded
 * that a 20,000-character signature was stored and rendered at every other
 * guest on the wall. The action now bounds it — a sanity bound on an input,
 * not an operational value, which is the distinction `savePracticalInfoAction`
 * already draws for its textarea.
 */
test('BE-4 a display name used as a second note body is refused', async ({ page }) => {
  const token = 'WriterTwoGGGGGGGGGG7xx';
  const long = 'A'.repeat(20_000);
  await page.goto(`/t/${token}`);
  await page.getByRole('button', { name: /edit my note/i }).click();
  await page.getByLabel('Sign it as').fill(long);
  await page.getByLabel('Your note').fill('Short body, enormous signature.');
  await page.getByRole('button', { name: /save my note/i }).click();

  /** Refused, and the note is not saved with it. */
  await expect(page.getByText('Your note has been sent')).toHaveCount(0);

  const [row] = await sql<{ display_name: string }[]>`
    select n.display_name from portal_notes n join attendees a on a.id = n.attendee_id
     where a.qr_token = ${token}`;
  console.log('stored display_name length:', row.display_name.length);
  expect(row.display_name.length).toBeLessThanOrEqual(120);
  await page.screenshot({ path: `${SHOTS}/BE-4-step-1-long-display-name-refused.png`, fullPage: true });

  await sql`update portal_notes n set display_name = 'Writer Two', is_anonymous = true,
                   body = 'I cried during the second movement.',
                   moderation_status = 'APPROVED', wall_status = 'PUBLISHED'
              from attendees a where a.id = n.attendee_id and a.qr_token = ${token}`;
});
