import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import postgres from 'postgres';
import { DB, SHOTS, signIn } from './rs-helpers';

/**
 * R x S seam, phase 5 — the flows in qa-artifacts/claude-S-audience-workspace-rs/02-flows.md.
 *
 * Seed first: seed-s.mjs then seed-rs.mjs. Serial: FLOW-9 (admin) captures the
 * Server Action ids and bodies FLOW-5/6 replay as the viewer.
 */
const OUT = 'qa-artifacts/claude-S-audience-workspace-rs';
const C = '/admin/concerts/1';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const VIEWS: Array<[string, string]> = [
  ['needs-review', 'Needs review'], ['unverified', 'Unverified'], ['needs-tickets', 'Needs tickets'],
  ['ready-to-send', 'Ready to send'], ['sent', 'Sent'], ['admitted', 'Admitted'], ['waitlisted', 'Waitlisted'],
  ['cancelled', 'Cancelled'], ['bounced', 'Bounced'], ['send-failed', 'Send failed'],
  ['suspicious-address', 'Suspicious address'], ['changed-after-send', 'Changed after send'],
  ['possible-duplicate', 'Possible duplicates'], ['unnamed-guests', 'Unnamed guests'],
  ['reply-waiting', 'Replies'], ['over-capacity', 'Over capacity'],
];
const FULL_EMAIL = /[A-Za-z0-9._%+-]+@(example\.test|gmail\.con|gmail\.com|operators\.invalid)/g;

const log: Record<string, unknown> = existsSync(`${OUT}/flows-log.json`)
  ? JSON.parse(readFileSync(`${OUT}/flows-log.json`, 'utf8'))
  : {};
const note = (k: string, v: unknown) => {
  log[k] = v;
  writeFileSync(`${OUT}/flows-log.json`, JSON.stringify(log, null, 2));
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const sql = () => postgres(DB, { max: 1 });

async function dbState() {
  const db = sql();
  const [r] = await db`
    select (select count(*)::int from command_runs) as runs,
           (select count(*)::int from audit_log) as audits,
           (select md5(string_agg(row(r.*)::text, '|' order by id)) from registrations r) as regs,
           (select md5(string_agg(row(a.*)::text, '|' order by id)) from attendees a) as seats,
           (select md5(string_agg(row(o.*)::text, '|' order by id)) from email_outbox o) as outbox`;
  await db.end();
  return r;
}

type Captured = { id: string; url: string; body: string; contentType: string };
const captured: Record<string, Captured> = existsSync(`${OUT}/captured-actions.json`)
  ? JSON.parse(readFileSync(`${OUT}/captured-actions.json`, 'utf8'))
  : {};

test.use({ viewport: { width: 1280, height: 800 } });
mkdirSync(SHOTS, { recursive: true });

test('FLOW-9 admin regression: approve from the record, edit the email', async ({ page }) => {
  test.setTimeout(240_000);
  page.on('request', (req) => {
    const id = req.headers()['next-action'];
    if (req.method() === 'POST' && id) {
      const body = req.postData() ?? '';
      const key = body.startsWith('["') ? `cmd:${JSON.parse(body)[0]}:${req.url()}:${Object.keys(captured).length}` : `form:${Object.keys(captured).length}`;
      captured[key] = { id, url: req.url(), body, contentType: req.headers()['content-type'] ?? '' };
      writeFileSync(`${OUT}/captured-actions.json`, JSON.stringify(captured, null, 2));
    }
  });
  await signIn(page, 'committee@example.test', 'qa-admin-pass');
  await expect(page).not.toHaveURL(/\/login/);
  await shot(page, 'FLOW-9-step-1-login');

  await page.goto(`${C}/audience/1`);
  await expect(page.getByRole('heading', { name: 'Player 1' })).toBeVisible();
  await expect(page.getByText('player1@example.test')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible();
  await expect(page.getByText('Read-only access')).toHaveCount(0);
  await shot(page, 'FLOW-9-step-2-record');

  await page.getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const runButton = dialog.locator('[data-slot="dialog-footer"] button').last();
  await expect(runButton).toBeEnabled({ timeout: 30_000 });
  await shot(page, 'FLOW-9-step-3-preview');
  await runButton.click();
  await expect(dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close' })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-9-step-4-report');

  const db = sql();
  const [reg] = await db`select approved_at from registrations where id = 1`;
  const [run] = await db`select id, command, actor_id::text, status from command_runs order by id desc limit 1`;
  const [aud] = await db`select actor_id::text, action from audit_log where entity_type = 'registration' and entity_id = '1' order by id desc limit 1`;
  note('FLOW-9 approve', { approvedAt: reg.approved_at, run, audit: aud });
  expect(reg.approved_at).not.toBeNull();
  expect(run.command).toBe('audience.approve');
  expect(run.actor_id).toBe(ADMIN_ID);
  expect(aud.actor_id).toBe(ADMIN_ID);
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close' }).click();

  // Edit Grace's email on her record (§22.4)
  await page.goto(`${C}/audience/8`);
  await expect(page.getByText('grace@gmail.con')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog');
  await edit.locator('input[name="contactEmail"]').fill('grace@gmail.com');
  await shot(page, 'FLOW-9-step-5-edit-email');
  await edit.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-9-step-6-saved');
  const [g] = await db`select contact_email::text from registrations where id = 8`;
  const [ga] = await db`select actor_id::text, before, after from audit_log where entity_type = 'registration' and entity_id = '8' and action = 'registration.updated' order by id desc limit 1`;
  note('FLOW-9 edit', { email: g.contact_email, audit: ga });
  expect(g.contact_email).toBe('grace@gmail.com');
  expect(ga.actor_id).toBe(ADMIN_ID);
  await db.end();
});

test('FLOW-10 admin search by address finds the party', async ({ page }) => {
  await signIn(page, 'committee@example.test', 'qa-admin-pass');
  await page.goto(`${C}/audience`);
  await page.getByPlaceholder(/Search name, email/).fill('alice@example.test');
  await expect(page).toHaveURL(/q=alice/, { timeout: 15_000 });
  await expect(page.locator('table tbody').getByText('Alice Tan')).toBeVisible();
  await expect(page.locator('table tbody').getByText('alice@example.test')).toBeVisible();
  await shot(page, 'FLOW-10-step-1-admin-search-email');
});

test('FLOW-1 viewer walks Audience, parties grain, every view', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await expect(page).not.toHaveURL(/\/login/);
  await shot(page, 'FLOW-1-step-1-login');

  await page.goto(`${C}/audience`);
  await expect(page.getByRole('heading', { name: 'Audience' })).toBeVisible();
  await expect(page.getByText('Read-only access')).toBeVisible();
  const text = await page.locator('main').innerText();
  const leaks = text.match(FULL_EMAIL) ?? [];
  const controls = {
    newParty: await page.getByRole('button', { name: 'New party' }).count(),
    actions: await page.getByRole('button', { name: /^Actions$|selected$/ }).count(),
    exportBtn: await page.getByRole('button', { name: /export/i }).count(),
    checkboxes: await page.getByRole('checkbox').count(),
    rows: await page.locator('table tbody tr').count(),
  };
  note('FLOW-1 step 2', { leaks, controls });
  expect(leaks).toEqual([]);
  expect(controls.newParty).toBe(0);
  expect(controls.actions).toBe(0);
  expect(controls.exportBtn).toBe(0);
  await shot(page, 'FLOW-1-step-2-audience');

  const db = sql();
  const counts: Record<string, unknown> = {};
  for (const [id, label] of VIEWS) {
    await page.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }).first().click();
    await expect(page).toHaveURL(new RegExp(`view=${id}`), { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    const main = await page.locator('main').innerText();
    const badge = await page.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }).first().innerText();
    const shown = Number(badge.match(/(\d+)\s*$/)?.[1]);
    const rows = await page.locator('table tbody a[href*="/audience/"]').evaluateAll((as) => new Set(as.map((a) => a.getAttribute('href'))).size);
    counts[id] = { badge: shown, rows, leaks: main.match(FULL_EMAIL) ?? [], error: /Something went wrong/.test(main) };
    expect(main.match(FULL_EMAIL) ?? [], id).toEqual([]);
    expect(rows, id).toBe(shown);
    if (id === 'needs-review') {
      await expect(page.getByText(/left in the pool|seats? left/i).first()).toBeVisible();
      await shot(page, 'FLOW-1-step-3-needs-review-pool-meter');
    }
  }
  const col = (flag: string) => db.unsafe(`select count(*)::int as n from party_pipeline where concert_id = 1 and ${flag}`);
  counts.sql_reply_waiting = (await col('flag_reply_waiting'))[0].n;
  counts.sql_changed_after_send = (await col('flag_changed_after_send'))[0].n;
  note('FLOW-1 step 3 views', counts);
  await shot(page, 'FLOW-1-step-4-last-view');
  await db.end();
});

test('FLOW-2 viewer toggles to seats grain', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await page.goto(`${C}/audience`);
  await page.getByRole('radio', { name: 'Seats' }).or(page.getByRole('button', { name: 'Seats' })).first().click();
  await expect(page).toHaveURL(/grain=seats/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  const tokenLinks = hrefs.filter((h) => /\/t\/|\/pdf|verify\?t=|\?k=|edit\?r=/.test(h));
  const main = await page.locator('main').innerText();
  note('FLOW-2', { tokenLinks, leaks: main.match(FULL_EMAIL) ?? [], ticketCodesShown: main.match(/ORC-[0-9A-Z]{4}/g) ?? [] });
  expect(tokenLinks).toEqual([]);
  expect(main.match(FULL_EMAIL) ?? []).toEqual([]);
  await shot(page, 'FLOW-2-step-1-seats');
});

test('FLOW-3 viewer search: name and id match, address and phone do not', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  const results: Record<string, string[]> = {};
  const search = async (q: string, name: string) => {
    await page.goto(`${C}/audience?q=${encodeURIComponent(q)}`);
    await page.waitForLoadState('networkidle');
    results[q] = await page.locator('table tbody a[href*="/audience/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')!.split('/').pop()!))]);
    await shot(page, name);
  };
  await search('Alice', 'FLOW-3-step-1-name');
  expect(results.Alice).toEqual(['5']);
  await search('ORC', 'FLOW-3-step-2-ticket-code');
  expect(results.ORC!.length).toBeGreaterThan(0);
  await search('alice@example.test', 'FLOW-3-step-3-full-address');
  expect(results['alice@example.test']).toEqual([]);
  await search('9123', 'FLOW-3-step-4-phone');
  expect(results['9123']).toEqual([]);
  await search('kai.hidden@e', 'FLOW-3-step-5-name-holds-address-right-guess');
  await search('kai.hidden@x', 'FLOW-3-step-6-name-holds-address-wrong-guess');
  note('FLOW-3', results);
  // §28: a row that appears for one guess and not the next spells the value out.
  expect(results['kai.hidden@e'], 'oracle on a masked name').toEqual(results['kai.hidden@x']);
});

test('FLOW-4 viewer opens a party record, every tab', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await page.goto(`${C}/audience`);
  await page.locator('table tbody').getByText('Alice Tan').first().click();
  await expect(page).toHaveURL(/\/audience\/5$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Alice Tan' })).toBeVisible();
  const controls = {
    edit: await page.getByRole('button', { name: 'Edit' }).count(),
    more: await page.getByRole('button', { name: 'More actions' }).count(),
    allSeats: await page.getByRole('button', { name: 'All seats' }).count(),
    pdf: await page.locator('a[href*="/pdf"]').count(),
    reply: await page.getByRole('textbox').count(),
    anyButtonInSeats: await page.locator('section[aria-labelledby="seats-heading"] button').count(),
  };
  note('FLOW-4 controls', controls);
  expect(controls).toEqual({ edit: 0, more: 0, allSeats: 0, pdf: 0, reply: 0, anyButtonInSeats: 0 });
  await shot(page, 'FLOW-4-step-1-header-seats');

  await page.getByRole('tab', { name: /Conversation/ }).click();
  const convo = await page.getByRole('tabpanel').innerText();
  const creds = convo.match(/(edit\?r=|verify\?t=|\?k=)[A-Za-z0-9_-]+/g) ?? [];
  const bare = convo.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?![.\w])/g) ?? [];
  const phones = convo.match(/\+65 9123 4567/g) ?? [];
  note('FLOW-4 conversation', { creds, tldLessAddresses: bare, phones });
  await shot(page, 'FLOW-4-step-2-conversation');

  await page.getByRole('tab', { name: /Activity/ }).click();
  const act = await page.getByRole('tabpanel').innerText();
  note('FLOW-4 activity', { text: act.slice(0, 800), leaks: act.match(FULL_EMAIL) ?? [] });
  await shot(page, 'FLOW-4-step-3-activity');

  await page.goto(`${C}/audience/6`);
  await page.getByRole('tab', { name: /Responses/ }).click();
  const resp = await page.getByRole('tabpanel').innerText();
  note('FLOW-4 responses', resp.slice(0, 600));
  expect(resp).not.toContain('daniel@example.test');
  expect(resp).not.toContain('345 6789');
  await shot(page, 'FLOW-4-step-4-responses');

  await page.goto(`${C}/audience/1`);
  await page.getByRole('tab', { name: /Responses/ }).click();
  const imp = await page.getByRole('tabpanel').innerText();
  note('FLOW-4 import', imp.slice(0, 600));
  expect(imp).not.toContain('555 0101');
  await shot(page, 'FLOW-4-step-5-import-row');

  expect(creds, 'credential links in the conversation').toEqual([]);
  expect(bare, 'TLD-less addresses in the conversation').toEqual([]);
});

test('FLOW-5 viewer replays command Server Actions', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await page.goto(`${C}/audience/5`);
  const preview = Object.values(captured).find((c) => c.body.startsWith('["audience.approve"') && !c.body.includes('confirmPhrase'));
  const cmds = Object.values(captured).filter((c) => c.body.startsWith('["audience.approve"'));
  const ids = [...new Set(cmds.map((c) => c.id))];
  expect(ids.length, 'captured preview + run ids').toBeGreaterThanOrEqual(2);
  const before = await dbState();
  const replies: Record<string, { status: number; body: string }> = {};
  const bodies = [
    JSON.stringify(['audience.delete', { concertId: 1, selection: { ids: [5] } }]),
    JSON.stringify(['audience.cancel', { concertId: 1, selection: { filter: {}, excludedIds: [] } }]),
    JSON.stringify(['seats.void_reissue', { concertId: 1, selection: { ids: [12] }, confirmPhrase: 'void and re-issue 1 seat' }]),
  ];
  for (const id of ids) {
    for (const body of bodies) {
      const r = await page.evaluate(
        async ({ url, id, body }) => {
          const res = await fetch(url, { method: 'POST', headers: { 'Next-Action': id, 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'text/x-component' }, body });
          return { status: res.status, body: (await res.text()).slice(0, 600) };
        },
        { url: preview!.url, id, body },
      );
      replies[`${id.slice(0, 10)} ${body.slice(0, 40)}`] = r;
    }
  }
  // continue / cancel the admin's run as a viewer
  const db = sql();
  const [run] = await db`select id from command_runs order by id desc limit 1`;
  await db.end();
  const after = await dbState();
  note('FLOW-5', { ids, replies, before, after, adminRun: run });
  await shot(page, 'FLOW-5-step-1-after-replay');
  for (const r of Object.values(replies)) {
    expect(r.body).not.toMatch(/"ok":true/);
    expect(r.body).not.toMatch(/at .*\.ts:\d+/);
  }
  expect(after).toEqual(before);
});

test('FLOW-6 viewer replays the record email edit', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await page.goto(`${C}/audience/8`);
  const form = Object.values(captured).find((c) => c.body.includes('grace@gmail.com'));
  expect(form, 'captured the admin email edit').toBeTruthy();
  const before = await dbState();
  const r = await page.evaluate(
    async ({ url, id, body, ct }) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Next-Action': id, 'Content-Type': ct, Accept: 'text/x-component' }, body });
      return { status: res.status, body: (await res.text()).slice(0, 800) };
    },
    { url: form!.url, id: form!.id, body: form!.body.replace('grace@gmail.com', 'evil@viewer.test'), ct: form!.contentType },
  );
  const after = await dbState();
  const db = sql();
  const [g] = await db`select contact_email::text from registrations where id = 8`;
  await db.end();
  note('FLOW-6', { reply: r, email: g.contact_email, same: JSON.stringify(before) === JSON.stringify(after) });
  await page.reload();
  await shot(page, 'FLOW-6-step-1-after-replay');
  expect(g.contact_email).toBe('grace@gmail.com');
  expect(after).toEqual(before);
});

test('FLOW-7 operator and anonymous are refused', async ({ page, browser }) => {
  const anon = await browser.newPage();
  const a1 = await anon.request.get(`${C}/audience`, { maxRedirects: 0 });
  const a2 = await anon.request.get(`${C}/audience/5`, { maxRedirects: 0 });
  await anon.goto(`${C}/audience/5`);
  await expect(anon).toHaveURL(/\/login/);
  await anon.screenshot({ path: `${SHOTS}/FLOW-7-step-1-anonymous.png`, fullPage: true });
  const anonBody = (await a2.text()) + (await a1.text());

  await page.goto('/scan/login');
  const inputs = page.locator('input');
  note('FLOW-7 scan login inputs', await inputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name)));
  await signInOperator(page);
  const o1 = await page.request.get(`${C}/audience`, { maxRedirects: 0 });
  const o2 = await page.request.get(`${C}/audience/5`, { maxRedirects: 0 });
  await page.goto(`${C}/audience/5`);
  await page.waitForLoadState('networkidle');
  await shot(page, 'FLOW-7-step-2-operator');
  const opBody = (await o1.text()) + (await o2.text());
  note('FLOW-7', {
    anon: [a1.status(), a1.headers().location, a2.status(), a2.headers().location],
    operator: [o1.status(), o1.headers().location, o2.status(), o2.headers().location, page.url()],
    anonLeak: /Alice Tan|alice@/.test(anonBody),
    opLeak: /Alice Tan|alice@/.test(opBody),
  });
  expect(/Alice Tan|a•••@|alice@/.test(anonBody)).toBe(false);
  expect(/Alice Tan|a•••@|alice@/.test(opBody)).toBe(false);
  expect(page.url()).not.toContain('/audience');
});

async function signInOperator(page: Page) {
  await page.goto('/scan/login');
  const names = await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name));
  if (names.includes('email')) await page.locator('input[name="email"]').fill('wei-ling@operators.invalid');
  if (names.includes('displayName')) await page.locator('input[name="displayName"]').fill('Wei Ling');
  if (names.includes('name')) await page.locator('input[name="name"]').fill('Wei Ling');
  const code = names.find((n) => /code|password/i.test(n));
  await page.locator(`input[name="${code}"]`).fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe('FLOW-8 timezone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('record times do not move with the browser zone', async ({ page }) => {
    await signIn(page, 'mei@example.test', 'qa-viewer-pass');
    await page.goto(`${C}/audience/5`);
    const la = await page.locator('dl').first().innerText();
    await shot(page, 'FLOW-8-step-1-los-angeles');
    note('FLOW-8 LA', la);
    const db = sql();
    const [c] = await db`select timezone from concerts where id = 1`;
    const [r] = await db`select to_char(requested_at at time zone ${c.timezone}, 'FMDD Mon YYYY, HH24:MI') as local from registrations where id = 5`;
    await db.end();
    note('FLOW-8 expected', { tz: c.timezone, local: r.local });
    expect(la.replace('Sept', 'Sep')).toContain(r.local);
  });
});
