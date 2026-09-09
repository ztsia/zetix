/**
 * QA phase 4 — module `G`'s backend, exercised against the real handlers.
 *
 * Written by the QA reviewer, not the module author. Nothing here is mocked:
 * the calls go to `next dev` on :3100 against `zetix_qa`, signed in through the
 * QA GoTrue stub, and every assertion is checked against the database
 * afterwards where a row is claimed.
 */
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import fs from 'node:fs';
import crypto from 'node:crypto';

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const seed = JSON.parse(fs.readFileSync('qa-artifacts/G-door-scanner/seed.json', 'utf8'));

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const hide = () => {
      const s = document.createElement('style');
      s.textContent = 'nextjs-portal{display:none!important}';
      document.head?.appendChild(s);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
}

async function signIn(page: Page, who: 'assigned' | 'unassigned' | 'admin') {
  await hideDevOverlay(page);
  if (who === 'admin') {
    await page.goto('/login');
    await page.fill('#code', 'qa-admin-code');
    await page.click('button[type=submit]');
    await page.waitForURL(/\/admin/);
    return;
  }
  await page.goto('/scan/login');
  await page.fill('#displayName', who === 'assigned' ? 'Wei Ling' : 'No Shows');
  await page.fill('#code', 'qa-op-code');
  await page.click('button[type=submit]');
  // `/scan/login` itself matches /\/scan/, so wait for the destination proper.
  await page.waitForURL(/\/scan(\/\d+)?$/);
}

/** In-page fetch, so the Supabase session cookies actually travel. */
async function call(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p as string, (i ?? undefined) as RequestInit);
      return { status: r.status, body: await r.text() };
    },
    [path, init ?? null] as const,
  );
}

test.beforeEach(async () => {
  await sql`delete from check_ins`;
});
test.afterAll(async () => {
  await sql.end();
});

// ---------------------------------------------------------------- manifest

test('QA4-manifest matrix: anonymous / admin / assigned / unassigned', async ({ page, context }) => {
  const rows: string[] = [];

  // anonymous — no session at all
  await hideDevOverlay(page);
  await page.goto('/scan/login');
  const anon = await call(page, `/api/checkin/manifest?showId=${seed.show1}`);
  rows.push(`anonymous          -> ${anon.status} ${anon.body.slice(0, 80)}`);
  expect(anon.status).toBe(401);
  expect(anon.body).not.toContain('Alice');

  // operator assigned to show 1
  await signIn(page, 'assigned');
  const own = await call(page, `/api/checkin/manifest?showId=${seed.show1}`);
  rows.push(`assigned, own show -> ${own.status}, ${JSON.parse(own.body).attendees.length} rows`);
  expect(own.status).toBe(200);
  expect(JSON.parse(own.body).attendees).toHaveLength(6);

  const other = await call(page, `/api/checkin/manifest?showId=${seed.show2}`);
  rows.push(`assigned, other show -> ${other.status} ${other.body}`);
  expect(other.status).toBe(404);
  expect(other.body).not.toContain('Siti');

  const missing = await call(page, `/api/checkin/manifest?showId=987654`);
  rows.push(`nonexistent show   -> ${missing.status} ${missing.body}`);
  expect(missing.status).toBe(404);
  // "not yours" must be indistinguishable from "not there"
  expect(missing.body).toBe(other.body);

  // operator with no assignments at all
  await context.clearCookies();
  await signIn(page, 'unassigned');
  const none = await call(page, `/api/checkin/manifest?showId=${seed.show1}`);
  rows.push(`unrostered operator -> ${none.status} ${none.body}`);
  expect(none.status).toBe(404);
  expect(none.body).not.toContain('Alice');

  // the shared ADMIN
  await context.clearCookies();
  await signIn(page, 'admin');
  const asAdmin = await call(page, `/api/checkin/manifest?showId=${seed.show2}`);
  rows.push(`ADMIN, any show    -> ${asAdmin.status}, ${JSON.parse(asAdmin.body).attendees.length} rows`);
  expect(asAdmin.status).toBe(200);
  expect(JSON.parse(asAdmin.body).attendees.length).toBeGreaterThan(0);

  console.log('MANIFEST MATRIX\n' + rows.join('\n'));
});

test('QA4-manifest hostile input returns a structured error, never a 500', async ({ page }) => {
  await signIn(page, 'assigned');
  const cases = [
    '',
    '?showId=',
    '?showId=abc',
    '?showId=-1',
    '?showId=0',
    '?showId=1.5',
    '?showId=9999999999999999999999',
    `?showId=${'9'.repeat(10000)}`,
    "?showId=1' or 1=1--",
    '?showId=../../etc/passwd',
    '?showId[]=1&showId[]=2',
  ];
  const seen: string[] = [];
  for (const c of cases) {
    const r = await call(page, `/api/checkin/manifest${c}`);
    seen.push(`${JSON.stringify(c).slice(0, 40)} -> ${r.status} ${r.body.slice(0, 70)}`);
    expect(r.status).toBeLessThan(500);
    expect(r.body).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack trace
    expect(r.body).not.toContain('Alice');
  }
  console.log('MANIFEST HOSTILE INPUT\n' + seen.join('\n'));
});

test('QA4-manifest carries digests and no raw token', async ({ page }) => {
  await signIn(page, 'assigned');
  const r = await call(page, `/api/checkin/manifest?showId=${seed.show1}`);
  const body = JSON.parse(r.body);
  for (const a of seed.tans.attendees) expect(r.body).not.toContain(a.token);
  for (const a of body.attendees) expect(a.qrTokenSha256).toMatch(/^[0-9a-f]{64}$/);
  // the cancelled attendee is present on purpose (§7.9)
  expect(body.attendees.map((a: { name: string }) => a.name)).toContain('Marcus Lee');
  expect(r.body).toContain('"status":"CANCELLED"');
  console.log('MANIFEST BODY\n' + r.body);
});

// -------------------------------------------------------------- scan write

const post = (page: Page, payload: unknown) =>
  call(page, '/api/checkin/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  } as unknown as RequestInit);

test('QA4-scan matrix: anonymous / assigned / unassigned / other show', async ({ page, context }) => {
  const aliceHash = sha(seed.tans.attendees[0].token);
  const at = new Date().toISOString();
  const one = (showId: number) => ({
    showId,
    scans: [{ qrTokenSha256: aliceHash, scannedAt: at, source: 'ONLINE', deviceId: 'qa-dev' }],
  });
  const rows: string[] = [];

  await hideDevOverlay(page);
  await page.goto('/scan/login');
  const anon = await post(page, one(seed.show1));
  rows.push(`anonymous            -> ${anon.status} ${anon.body}`);
  expect(anon.status).toBe(401);

  await signIn(page, 'unassigned');
  const unassigned = await post(page, one(seed.show1));
  rows.push(`unrostered operator  -> ${unassigned.status} ${unassigned.body}`);
  expect(unassigned.status).toBe(404);

  await context.clearCookies();
  await signIn(page, 'assigned');
  const wrongShow = await post(page, one(seed.show2));
  rows.push(`assigned, other show -> ${wrongShow.status} ${wrongShow.body}`);
  expect(wrongShow.status).toBe(404);

  // Nothing above may have written a row.
  const [{ count: after }] = await sql`select count(*)::int as count from check_ins`;
  rows.push(`check_ins after all refusals = ${after}`);
  expect(after).toBe(0);

  const ok = await post(page, one(seed.show1));
  rows.push(`assigned, own show   -> ${ok.status} ${ok.body}`);
  expect(ok.status).toBe(200);
  const [row] = await sql`select attendee_id, show_id, source, device_id, operator_id,
                                 scanned_at, synced_at, override_reason from check_ins`;
  rows.push(`row: ${JSON.stringify(row)}`);
  expect(row.source).toBe('ONLINE');
  expect(Number(row.show_id)).toBe(seed.show1);
  expect(row.device_id).toBe('qa-dev');
  expect(new Date(row.scanned_at).toISOString()).toBe(at);

  console.log('SCAN MATRIX\n' + rows.join('\n'));
});

test('QA4-scan is idempotent on a retried drain, and appends a genuine second scan', async ({
  page,
}) => {
  await signIn(page, 'assigned');
  const hash = sha(seed.tans.attendees[0].token);
  const at = new Date().toISOString();
  const batch = {
    showId: seed.show1,
    scans: [{ qrTokenSha256: hash, scannedAt: at, source: 'OFFLINE_SYNC', deviceId: 'qa-dev' }],
  };
  const first = await post(page, batch);
  const second = await post(page, batch); // the same drain, retried
  const [{ count }] = await sql`select count(*)::int as count from check_ins`;
  expect(JSON.parse(first.body).receipts[0].outcome).toBe('RECORDED');
  expect(JSON.parse(second.body).receipts[0].outcome).toBe('ALREADY_SYNCED');
  expect(count).toBe(1);

  // A genuinely separate scan (different instant) must land as a second row.
  const later = new Date(Date.now() + 60_000).toISOString();
  await post(page, {
    showId: seed.show1,
    scans: [{ qrTokenSha256: hash, scannedAt: later, source: 'ONLINE', deviceId: 'qa-dev' }],
  });
  const [{ count: two }] = await sql`select count(*)::int as count from check_ins`;
  expect(two).toBe(2);
  console.log(`retried drain -> 1 row; genuine second scan -> ${two} rows`);
});

test('QA4-scan: two devices scanning the same ticket both land (§12.3, no locking)', async ({
  page,
}) => {
  await signIn(page, 'assigned');
  const hash = sha(seed.tans.attendees[0].token);
  const a = new Date().toISOString();
  const b = new Date(Date.now() + 1000).toISOString();
  await post(page, {
    showId: seed.show1,
    scans: [{ qrTokenSha256: hash, scannedAt: a, source: 'OFFLINE_SYNC', deviceId: 'phone-A' }],
  });
  const second = await post(page, {
    showId: seed.show1,
    scans: [{ qrTokenSha256: hash, scannedAt: b, source: 'OFFLINE_SYNC', deviceId: 'phone-B' }],
  });
  const rows = await sql`select device_id, source from check_ins order by scanned_at`;
  expect(rows).toHaveLength(2);
  const receipt = JSON.parse(second.body).receipts[0];
  expect(receipt.scanCount).toBe(2); // the multi-scan flag
  expect(receipt.firstScan).not.toBeNull();
  console.log(`two devices -> ${JSON.stringify(rows)} receipt=${JSON.stringify(receipt)}`);
});

test('QA4-scan: a ticket for another show is reported as WRONG_SHOW and writes nothing', async ({
  page,
}) => {
  await signIn(page, 'assigned');
  const r = await post(page, {
    showId: seed.show1,
    scans: [
      {
        qrTokenSha256: sha(seed.other.attendees[0].token),
        scannedAt: new Date().toISOString(),
        source: 'ONLINE',
        deviceId: 'qa-dev',
      },
    ],
  });
  const receipt = JSON.parse(r.body).receipts[0];
  expect(receipt.outcome).toBe('WRONG_SHOW');
  expect(receipt.showName).toBe('Saturday Matinee');
  const [{ count }] = await sql`select count(*)::int as count from check_ins`;
  expect(count).toBe(0);
  console.log(`wrong show receipt: ${JSON.stringify(receipt)}`);
});

test('QA4-scan: a cancelled ticket is recorded without complaint by the server', async ({
  page,
}) => {
  await signIn(page, 'assigned');
  const r = await post(page, {
    showId: seed.show1,
    scans: [
      {
        qrTokenSha256: sha(seed.cancelled.attendees[0].token),
        scannedAt: new Date().toISOString(),
        source: 'MANUAL',
        deviceId: 'qa-dev',
        overrideReason: 'QA: admitted over a cancelled ticket',
      },
    ],
  });
  const receipt = JSON.parse(r.body).receipts[0];
  const [row] = await sql`select source, override_reason from check_ins`;
  console.log(`cancelled: ${JSON.stringify(receipt)} row=${JSON.stringify(row)}`);
  expect(receipt.outcome).toBe('RECORDED');
  expect(row.source).toBe('MANUAL');
});

test('QA4-scan hostile payloads', async ({ page }) => {
  await signIn(page, 'assigned');
  const now = new Date().toISOString();
  const bad: [string, unknown][] = [
    ['null body', null],
    ['empty object', {}],
    ['no scans', { showId: seed.show1, scans: [] }],
    ['showId as string', { showId: String(seed.show1), scans: [] }],
    [
      'hash not hex',
      { showId: seed.show1, scans: [{ qrTokenSha256: 'zz', scannedAt: now, source: 'ONLINE', deviceId: 'd' }] },
    ],
    [
      'hash with SQL',
      {
        showId: seed.show1,
        scans: [
          { qrTokenSha256: "' or 1=1--", scannedAt: now, source: 'ONLINE', deviceId: 'd' },
        ],
      },
    ],
    [
      'source not in enum',
      { showId: seed.show1, scans: [{ qrTokenSha256: sha('x'), scannedAt: now, source: 'ADMIN', deviceId: 'd' }] },
    ],
    [
      'scannedAt garbage',
      { showId: seed.show1, scans: [{ qrTokenSha256: sha('x'), scannedAt: 'yesterday', source: 'ONLINE', deviceId: 'd' }] },
    ],
    [
      'deviceId 10k chars',
      { showId: seed.show1, scans: [{ qrTokenSha256: sha('x'), scannedAt: now, source: 'ONLINE', deviceId: 'd'.repeat(10000) }] },
    ],
    [
      'overrideReason 10k chars',
      { showId: seed.show1, scans: [{ qrTokenSha256: sha('x'), scannedAt: now, source: 'ONLINE', deviceId: 'd', overrideReason: 'r'.repeat(10000) }] },
    ],
    [
      '501 scans',
      {
        showId: seed.show1,
        scans: Array.from({ length: 501 }, () => ({
          qrTokenSha256: sha('x'), scannedAt: now, source: 'ONLINE', deviceId: 'd',
        })),
      },
    ],
    [
      'path traversal in deviceId',
      { showId: seed.show1, scans: [{ qrTokenSha256: sha('x'), scannedAt: now, source: 'ONLINE', deviceId: '../../etc/passwd' }] },
    ],
  ];
  const seen: string[] = [];
  for (const [label, payload] of bad) {
    const r = await post(page, payload);
    seen.push(`${label.padEnd(26)} -> ${r.status} ${r.body.slice(0, 90)}`);
    expect(r.status, label).toBeLessThan(500);
    expect(r.body, label).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  }
  const [{ count }] = await sql`select count(*)::int as count from check_ins`;
  seen.push(`rows written by hostile payloads = ${count}`);
  console.log('SCAN HOSTILE INPUT\n' + seen.join('\n'));
});

test('QA4-scan: an assignment revoked mid-event refuses the next drain', async ({ page }) => {
  await signIn(page, 'assigned');
  const hash = sha(seed.tans.attendees[1].token);
  const at = new Date().toISOString();
  // The scan was made while rostered...
  const ok = await post(page, {
    showId: seed.show1,
    scans: [{ qrTokenSha256: hash, scannedAt: at, source: 'ONLINE', deviceId: 'qa-dev' }],
  });
  expect(ok.status).toBe(200);

  // ...and the roster changes before the phone next syncs.
  await sql`delete from operator_show_assignments where user_id = ${seed.OP1_ID}`;
  try {
    const later = new Date(Date.now() + 5000).toISOString();
    const refused = await post(page, {
      showId: seed.show1,
      scans: [{ qrTokenSha256: hash, scannedAt: later, source: 'OFFLINE_SYNC', deviceId: 'qa-dev' }],
    });
    console.log(`after revocation -> ${refused.status} ${refused.body}`);
    expect(refused.status).toBe(404);
    const [{ count }] = await sql`select count(*)::int as count from check_ins`;
    expect(count).toBe(1); // only the pre-revocation row
  } finally {
    await sql`insert into operator_show_assignments (user_id, show_id)
              values (${seed.OP1_ID}::uuid, ${seed.show1})
              on conflict do nothing`;
  }
});
