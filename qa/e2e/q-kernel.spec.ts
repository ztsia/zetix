import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * QA for module Q — Trash, the command dialog, Activity. Flows from
 * qa-artifacts/Q-platform-kernel/02-flows.md. Seed: qa/support/start-q.sh.
 * Admin surface is web-first: Desktop Chrome (chromium project only).
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 2 });
const SHOTS = 'qa-artifacts/Q-platform-kernel/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile, 'admin is desktop');

let concertId: number;
let admin: BrowserContext;

async function asAdmin(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
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

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

test.beforeAll(async ({ browser }) => {
  const [c] = await sql`select id from concerts order by id limit 1`;
  concertId = Number(c.id);
  const [seg] = await sql`select id, show_id from show_segments where id = 1`;
  // Idempotent: a worker restarted after a failing test runs this again.
  await sql`delete from concerts where slug = 'other-q'`;
  await sql`delete from registrations where contact_name like 'Bulk Party%' or contact_name in ('Admitted Family', 'Queue Family')`;

  // A second concert with its own deleted party: must never appear in concert 1's Trash.
  const [c2] = await sql`insert into concerts (name, slug, status, timezone) values ('Other Concert','other-q','ACTIVE','Europe/London') returning id`;
  const [s2] = await sql`insert into shows (concert_id, name, status, capacity, starts_at) values (${c2.id}, 'Other Show', 'OPEN', 50, now() + interval '20 days') returning id`;
  const [g2] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy) values (${s2.id}, 'Pub', 'PUBLIC', 50, 'AUTO_FCFS') returning id`;
  const [r2] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${s2.id}, ${g2.id}, 'ADMIN', 'Foreign Family', 'foreign@example.test', 'CONFIRMED', now()) returning id`;
  await sql`update registrations set deleted_at = now() where id = ${r2.id}`;

  // A party with a guest admitted at the door, then soft-deleted.
  const [adm] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${seg.show_id}, ${seg.id}, 'ADMIN', 'Admitted Family', 'admitted@example.test', 'CONFIRMED', now()) returning id`;
  await sql`select claim_seats(${seg.id}::bigint, ${adm.id}::bigint, '[{"full_name":"Inside Already","allocation_type":"COMP"}]'::jsonb, false)`;
  const [a] = await sql`select id from attendees where registration_id = ${adm.id}`;
  await sql`insert into check_ins (attendee_id, show_id, scanned_at, source) values (${a.id}, ${seg.show_id}, now(), 'MANUAL')`;
  await sql`update registrations set deleted_at = now() where id = ${adm.id}`;

  // Twenty bulk parties in the Trash, for "select all N matching" + the typed phrase (threshold 2).
  for (let i = 1; i <= 20; i++) {
    const [r] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
      values (${seg.show_id}, ${seg.id}, 'ADMIN', ${`Bulk Party ${String(i).padStart(2, '0')}`}, ${`bulk${i}@example.test`}, 'CONFIRMED', now()) returning id`;
    await sql`update registrations set deleted_at = now() where id = ${r.id}`;
  }
  // Tickets on Tan Family so qr_token survival is observable.
  await sql`update attendees set qr_token = 'qa-q-' || id, ticket_code = 'QAQ-' || id where registration_id = 7`;

  admin = await asAdmin(browser);
});

test.afterAll(async () => {
  await admin?.close();
  await sql.end();
});

test('FLOW-1 Trash lists this concert only', async () => {
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/trash`);
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  await shot(page, 'FLOW-1-step-1-trash');
  // 5 seeded + Admitted + 20 bulk = 26 in this concert; Foreign Family (concert 2) is not counted.
  await expect(page.getByRole('tab', { name: /Parties/ })).toContainText('26');
  await expect(page.getByText('26 rows')).toBeVisible();
  await page.goto(`/admin/concerts/${concertId}/trash?page=2`);
  await expect(row(page, 'Tan Family')).toHaveCount(1);
  await shot(page, 'FLOW-1-step-2-page-2');
  await page.goto(`/admin/concerts/${concertId}/trash?q=Foreign`);
  await expect(page.getByText('No matches')).toBeVisible();
  await expect(page.getByText('Foreign Family')).toHaveCount(0);
  await shot(page, 'FLOW-1-step-3-foreign-not-listed');
  // Seats tab: the seat removed on its own (Aman Kaur), not seats of deleted parties.
  await page.goto(`/admin/concerts/${concertId}/trash`);
  await page.getByRole('tab', { name: /Seats/ }).click();
  await expect(page).toHaveURL(/kind=seat/);
  await expect(row(page, 'Aman Kaur')).toHaveCount(1);
  await expect(page.getByText('Tan Family 1')).toHaveCount(0);
  await shot(page, 'FLOW-1-step-4-seats-tab');
  await page.close();
});

test('FLOW-2 Restore a deleted party with room', async () => {
  const before = await sql`select id, qr_token, ticket_code from attendees where registration_id = 7 order by id`;
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/trash?q=Tan`);
  await expect(row(page, 'Tan Family')).toHaveCount(1);
  await row(page, 'Tan Family').getByRole('checkbox').check();
  await shot(page, 'FLOW-2-step-1-selected');
  await page.getByRole('button', { name: 'Restore 1 party' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/confirmed seats will be checked against capacity again/)).toBeVisible();
  await shot(page, 'FLOW-2-step-2-preview');
  await dialog.getByRole('button', { name: 'Restore 1 party' }).click();
  await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-2-step-3-report');
  const [r] = await sql`select deleted_at from registrations where id = 7`;
  expect(r.deleted_at).toBeNull();
  const after = await sql`select id, status, qr_token, ticket_code from attendees where registration_id = 7 order by id`;
  expect(after.map((s) => s.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  expect(after.map((s) => [s.qr_token, s.ticket_code])).toEqual(before.map((s) => [s.qr_token, s.ticket_code]));
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByText('Tan Family')).toHaveCount(0);
  await shot(page, 'FLOW-2-step-4-gone-from-trash');
  await page.close();
});

test('FLOW-3 Restore when the segment has filled comes back waitlisted', async () => {
  const [{ n }] = await sql`select count(*)::int as n from attendees a join registrations r on r.id = a.registration_id
    where a.segment_id = 1 and a.status = 'CONFIRMED' and a.deleted_at is null and r.deleted_at is null`;
  await sql`update show_segments set capacity = ${n} where id = 1`;
  try {
    const page = await admin.newPage();
    await page.goto(`/admin/concerts/${concertId}/trash?q=Lim`);
    await row(page, 'Lim Household').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Restore 1 party' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Any that no longer fit come back waitlisted/)).toBeVisible();
    await shot(page, 'FLOW-3-step-1-preview');
    await dialog.getByRole('button', { name: 'Restore 1 party' }).click();
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
    await shot(page, 'FLOW-3-step-2-report');
    const seats = await sql`select status from attendees where registration_id = 8 order by id`;
    expect(seats.map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);
    const [{ m }] = await sql`select count(*)::int as m from attendees a join registrations r on r.id = a.registration_id
      where a.segment_id = 1 and a.status = 'CONFIRMED' and a.deleted_at is null and r.deleted_at is null`;
    expect(m).toBe(n);
    await page.close();
  } finally {
    await sql`update show_segments set capacity = 300 where id = 1`;
  }
});

test('FLOW-4 Delete permanently refuses a party with a guest admitted', async () => {
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/trash?q=Admitted`);
  await row(page, 'Admitted Family').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/admitted at the door/)).toBeVisible();
  await expect(dialog.getByText('Nothing in this selection can be acted on.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Delete permanently 0 parties/ })).toBeDisabled();
  await shot(page, 'FLOW-4-step-1-refused-preview');
  const [{ n }] = await sql`select count(*)::int as n from registrations where contact_name = 'Admitted Family'`;
  expect(n).toBe(1);
  await page.close();
});

test('FLOW-5 Select all matching, typed phrase, run-time recount, purge', async () => {
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/trash?q=Bulk&size=10`);
  await expect(page.getByRole('row').filter({ hasText: 'Bulk Party' })).toHaveCount(10);
  // Tick the header checkbox (this page), then "select all 20 matching".
  await page.getByRole('row').first().getByRole('checkbox').check();
  await shot(page, 'FLOW-5-step-1-page-selected');
  await page.getByRole('button', { name: /Select all 20/ }).click();
  await expect(page.getByText(/All\s*20\s*parties matching these filters are selected/)).toBeVisible();
  await shot(page, 'FLOW-5-step-2-all-matching');

  await page.getByRole('button', { name: 'Delete permanently' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('delete permanently 20 parties', { exact: true })).toBeVisible();
  const runButton = dialog.getByRole('button', { name: 'Delete permanently 20 parties' });
  await expect(runButton).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('delete permanently 19 parties');
  await expect(runButton).toBeDisabled();
  await shot(page, 'FLOW-5-step-3-wrong-phrase-disabled');

  // Another admin deletes one more matching party between preview and run.
  const [seg] = await sql`select id, show_id from show_segments where id = 1`;
  const [late] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${seg.show_id}, ${seg.id}, 'ADMIN', 'Bulk Party 21', 'bulk21@example.test', 'CONFIRMED', now()) returning id`;
  await sql`update registrations set deleted_at = now() where id = ${late.id}`;

  await dialog.getByLabel(/to confirm/).fill('delete permanently 20 parties');
  await expect(runButton).toBeEnabled();
  await runButton.click();
  await expect(dialog.getByText(/now comes to 21 parties/)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-5-step-4-recount-refused');
  const [{ n21 }] = await sql`select count(*)::int as n21 from registrations where contact_name like 'Bulk Party%'`;
  expect(n21).toBe(21);

  // Back to preview: close and reopen, phrase for 21.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog.getByText('delete permanently 21 parties', { exact: true })).toBeVisible();
  await dialog.getByLabel(/Reason/).fill('QA purge of test parties');
  await dialog.getByLabel(/to confirm/).fill('delete permanently 21 parties');
  await shot(page, 'FLOW-5-step-5-correct-phrase');
  await dialog.getByRole('button', { name: 'Delete permanently 21 parties' }).click();
  // §23.1 phase 3: the per-row report must be shown. Soft, so the DB checks below still run.
  await expect.soft(dialog.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-5-step-6-report');
  await expect.poll(async () => (await sql`select count(*)::int as left from registrations where contact_name like 'Bulk Party%'`)[0].left, { timeout: 30_000 }).toBe(0);
  const audits = await sql`select row_to_json(l)::text as t from audit_log l where action = 'registration.purged'`;
  expect(audits.length).toBe(21);
  for (const a of audits) {
    expect(a.t).not.toMatch(/bulk\d+@example\.test|Bulk Party/);
    expect(a.t).toContain('QA purge of test parties');
  }
  const [run] = await sql`select selection::text as s from command_runs where command = 'trash.purge.party' order by id desc limit 1`;
  expect(run.s).toContain('"filter"');
  await page.close();
});

test('FLOW-6 Activity renders in the concert timezone, not the browser zone', async ({ browser }) => {
  const [{ tz }] = await sql`select timezone as tz from concerts where id = ${concertId}`;
  const [latest] = await sql`select created_at from audit_log where concert_id = ${concertId} order by created_at desc, id desc limit 1`;
  const expected = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: tz }).format(latest.created_at);
  const viewerZone = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'America/Los_Angeles' }).format(latest.created_at);
  expect(expected).not.toBe(viewerZone);

  const ctx = await asAdmin(browser, { timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/activity`);
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.getByText(expected).first()).toBeVisible();
  await expect(page.getByText(viewerZone)).toHaveCount(0);
  await shot(page, 'FLOW-6-step-1-changes');
  await expect(page.getByText(/registration\.purged|purged/i).first()).toBeVisible();

  await page.goto(`/admin/concerts/${concertId}/activity?tab=runs`);
  await expect(page.getByText(/trash\.purge\.party|Delete permanently/i).first()).toBeVisible();
  await shot(page, 'FLOW-6-step-2-runs');
  await ctx.close();
});

test('FLOW-7 Anonymous and operator cannot reach Trash, Activity, or the command actions', async ({ browser }) => {
  // Capture a real admin preview Server Action call.
  const page = await admin.newPage();
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action'] && (req.postData() ?? '').includes('trash.')) {
      captured ??= { url: req.url(), headers: req.headers(), body: req.postData() ?? '' };
    }
  });
  await page.goto(`/admin/concerts/${concertId}/trash?q=Ong`);
  await row(page, 'Ong Party').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Restore 1 party' }).click();
  await expect(page.getByRole('dialog').getByText(/checked against capacity/)).toBeVisible();
  expect(captured).not.toBeNull();
  // Also capture the run POST: run it as admin, then put Ong back in the Trash.
  let capturedRun: { url: string; headers: Record<string, string>; body: string } | null = null;
  page.on('request', (req) => {
    const body = req.postData() ?? '';
    if (req.method() === 'POST' && req.headers()['next-action'] && body.includes('trash.') && req.headers()['next-action'] !== captured!.headers['next-action']) {
      capturedRun ??= { url: req.url(), headers: req.headers(), body };
    }
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Restore 1 party' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
  await page.close();
  expect(capturedRun).not.toBeNull();
  await sql`update attendees set deleted_at = now() where registration_id = 9`;
  await sql`update registrations set deleted_at = (select deleted_at from attendees where registration_id = 9 limit 1) where id = 9`;
  const [{ runsBefore }] = await sql`select count(*)::int as "runsBefore" from command_runs`;

  const anon = await browser.newContext();
  const op = await browser.newContext();
  const opPage = await op.newPage();
  await opPage.goto('/scan/login');
  await opPage.getByLabel('Display name').fill('Wei Ling');
  await opPage.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    opPage.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    opPage.getByRole('button', { name: 'Sign in' }).click(),
  ]);

  const results: Record<string, Record<string, string>> = {};
  for (const [who, ctx] of [['anonymous', anon], ['OPERATOR', op], ['ADMIN', admin]] as const) {
    results[who] = {};
    for (const path of [`/admin/concerts/${concertId}/trash`, `/admin/concerts/${concertId}/activity`]) {
      const p = await ctx.newPage();
      const res = await p.goto(path);
      results[who][path] = `${res?.status()} → ${new URL(p.url()).pathname}`;
      if (who !== 'ADMIN') {
        await expect(p.getByText('Ong Party')).toHaveCount(0);
        await expect(p.getByText('Wong Guests')).toHaveCount(0);
      }
      await shot(p, `FLOW-7-step-1-${who}-${path.split('/').pop()}`);
      await p.close();
    }
    const res = await ctx.request.post(captured!.url, {
      headers: { 'next-action': captured!.headers['next-action'], 'content-type': captured!.headers['content-type'] ?? 'text/plain;charset=UTF-8' },
      data: captured!.body,
    });
    const text = await res.text();
    results[who]['previewCommandAction replay'] = `${res.status()} ${/Ong Party/.test(text) ? 'LEAKS DATA' : 'no data'}`;
    if (who !== 'ADMIN') {
      const r2 = await ctx.request.post(capturedRun!.url, {
        headers: { 'next-action': capturedRun!.headers['next-action'], 'content-type': capturedRun!.headers['content-type'] ?? 'text/plain;charset=UTF-8' },
        data: capturedRun!.body,
      });
      const [{ del }] = await sql`select (deleted_at is not null) as del from registrations where id = 9`;
      const [{ runs }] = await sql`select count(*)::int as runs from command_runs`;
      results[who]['runCommandAction replay'] = `${r2.status()} ong_still_deleted=${del} new_runs=${runs - runsBefore}`;
    }
  }
  console.log('AUTHZ MATRIX', JSON.stringify(results, null, 2));
  expect(results.anonymous['previewCommandAction replay']).toMatch(/no data/);
  expect(results.OPERATOR['previewCommandAction replay']).toMatch(/no data/);
  expect(results.ADMIN['previewCommandAction replay']).toMatch(/LEAKS DATA/); // admin legitimately sees the preview
  expect(results.anonymous['runCommandAction replay']).toMatch(/ong_still_deleted=true new_runs=0/);
  expect(results.OPERATOR['runCommandAction replay']).toMatch(/ong_still_deleted=true new_runs=0/);
  expect(results.anonymous[`/admin/concerts/${concertId}/trash`]).toMatch(/\/login/);
  expect(results.OPERATOR[`/admin/concerts/${concertId}/trash`]).toMatch(/\/scan/);
  await anon.close();
  await op.close();
});

test('FLOW-8 Restoring a removed seat of a waitlisted party (sad)', async () => {
  // Matinee public segment: fill it so a new party waitlists, then open room without promoting anyone.
  const [seg] = await sql`select id, show_id, capacity from show_segments where id = 3`;
  const [{ n }] = await sql`select count(*)::int as n from attendees where segment_id = 3 and status = 'CONFIRMED' and deleted_at is null`;
  await sql`update show_segments set capacity = ${n} where id = 3`;
  const [q] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${seg.show_id}, 3, 'ADMIN', 'Queue Family', 'queue@example.test', 'WAITLIST', now()) returning id`;
  await sql`select claim_seats(3::bigint, ${q.id}::bigint, '[{"full_name":"Queue One","allocation_type":"COMP"},{"full_name":"Queue Two","allocation_type":"COMP"}]'::jsonb, false)`;
  await sql`update show_segments set capacity = ${seg.capacity} where id = 3`;
  const before = await sql`select id, status from attendees where registration_id = ${q.id} order by id`;
  expect(before.map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);
  // Admin removes one waitlisted seat (what removeAttendee() does).
  await sql`update attendees set status = 'CANCELLED', deleted_at = now() where id = ${before[0].id}`;

  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/trash?kind=seat&q=Queue`);
  await row(page, 'Queue One').getByRole('checkbox').check();
  await shot(page, 'FLOW-8-step-1-seat-selected');
  await page.getByRole('button', { name: 'Restore 1 seat' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Restore 1 seat' })).toBeVisible();
  await shot(page, 'FLOW-8-step-2-preview');
  await dialog.getByRole('button', { name: 'Restore 1 seat' }).click();
  await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-8-step-3-report');
  const after = await sql`select status from attendees where registration_id = ${q.id} order by id`;
  console.log('FLOW-8 seats after restore:', after.map((s) => s.status));
  // Spec: the waitlist is not jumped and the party is not split (allocation §7.3, §7.4; v3 §23.6).
  expect(after.map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);
  await page.close();
});

test('PHASE-4 hostile input through the real previewCommandAction (admin session)', async () => {
  const page = await admin.newPage();
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action'] && (req.postData() ?? '').includes('trash.')) {
      captured ??= { url: req.url(), headers: req.headers(), body: req.postData() ?? '' };
    }
  });
  await page.goto(`/admin/concerts/${concertId}/trash?q=Chen`);
  await row(page, 'Chen Group').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Restore 1 party' }).click();
  await expect(page.getByRole('dialog').getByText(/checked against capacity/)).toBeVisible();
  await page.close();
  console.log('captured body:', captured!.body);

  const cases: [string, unknown[]][] = [
    ['unknown command', ['../../etc/passwd', { concertId, selection: { ids: [10] } }]],
    ['ids as strings', ['trash.restore.party', { concertId, selection: { ids: ['10'] } }]],
    ['missing selection', ['trash.restore.party', { concertId }]],
    ['sql in search', ['trash.purge.party', { concertId, selection: { filter: { search: "'; delete from registrations; --" }, excludedIds: [] } }]],
    ['10k-char search', ['trash.purge.party', { concertId, selection: { filter: { search: 'x'.repeat(10_000) }, excludedIds: [] } }]],
    ['other concert id', ['trash.purge.party', { concertId: 999999, selection: { ids: [10] } }]],
    ['negative concert', ['trash.purge.party', { concertId: -1, selection: { ids: [10] } }]],
  ];
  const out: string[] = [];
  for (const [label, args] of cases) {
    const res = await admin.request.post(captured!.url, {
      headers: { 'next-action': captured!.headers['next-action'], 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' },
      data: JSON.stringify(args),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.includes('"ok"')) ?? text.slice(0, 200);
    out.push(`${label}: ${res.status()} ${line.slice(0, 220)}`);
    expect(res.status(), label).toBeLessThan(500);
    expect(text, label).not.toMatch(/at .*\.ts:\d+|stack/i);
  }
  console.log('HOSTILE\n' + out.join('\n'));
  const [{ n }] = await sql`select count(*)::int as n from registrations`;
  expect(n).toBeGreaterThan(0);
});
