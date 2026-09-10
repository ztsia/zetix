/**
 * QA phase-5 browser pass for module `I` — the read-only ticket status page at
 * `/t/{qr_token}`.
 *
 * Fixtures come from `qa/support/seed-i.mjs` (see `qa/support/start-i.sh`).
 * Run at a **phone viewport** throughout: the portal is mobile-first
 * (spec/surfaces.md §15, row 4; §15.3) and the reader is a guest holding their
 * own handset outside a hall.
 *
 * Every flow asserts before it screenshots. The screenshot is evidence for a
 * human; the assertion is the test.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';

const QA_URL = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(QA_URL, { prepare: false, max: 3 });
const SHOTS = 'qa-artifacts/I-ticket-status-page/screens';
const APP_URL = 'https://zetix.vercel.app';

const T = {
  issued: 'IssuedAAAAAAAAAAAAAA01',
  partyMate: 'PartyMateBBBBBBBBBBB02',
  admitted: 'AdmittedCCCCCCCCCCCC03',
  reverted: 'RevertedDDDDDDDDDDDD04',
  cancelled: 'CancelledEEEEEEEEEEE05',
  placeholder: 'PlaceholderFFFFFFFFF06',
  deleted: 'DeletedGGGGGGGGGGGGG07',
  waitlisted: 'WaitlistHHHHHHHHHHHH08',
  unknown: 'ZZZZZZZZZZZZZZZZZZZZZZ',
};

/** Canaries seeded so a leak is a string match rather than a judgement call. */
const CANARY = {
  segment: 'SEGMENT-LEAK-CANARY',
  contactEmail: 'booker-canary@example.test',
  contactPhone: '+60-CANARY-PHONE',
  partyMateName: 'Partner Canary Lim',
};

test.use({ viewport: { width: 390, height: 844 } });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** Everything a read-only page must not have changed. */
async function snapshot() {
  const [a] = await sql<{ digest: string }[]>`
    select md5(string_agg(
      concat_ws('|', id, qr_token, ticket_code, full_name, status, deleted_at,
                ticket_issued_at, ticket_sent_at, needs_reissue), '/' order by id)) as digest
      from attendees`;
  const [k] = await sql<{ n: number }[]>`select count(*)::int as n from check_ins`;
  const [g] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log`;
  return { attendees: a.digest, checkIns: k.n, audit: g.n };
}

test.describe('FLOW-1  a ticket holder scans their own QR three days early', () => {
  test('shows name, show, date, doors, venue and QR — and nothing else', async ({ page }) => {
    await page.goto(`/t/${T.issued}`);
    await expect(page.getByRole('heading', { name: 'Evening Concert' })).toBeVisible();
    await shot(page, 'FLOW-1-step-1-open');

    // The six fields README.md §4.1 names, each asserted as visible text.
    await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
    await expect(page.getByText('Sat 19 Sep 2026')).toBeVisible();
    await expect(page.getByText('Doors open 19:00')).toBeVisible();
    await expect(page.getByText('Starts 19:30')).toBeVisible();
    await expect(page.getByText('Dewan Filharmonik Petronas')).toBeVisible();
    await expect(page.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
    // §13.2 row 1: the instruction and the countdown.
    await expect(page.getByText('Present this QR at the door')).toBeVisible();
    await expect(page.getByText(/Doors open in \d+ days?/)).toBeVisible();
    // The map link (§13.2 "venue with map link").
    const map = page.locator('a[href*="google.com/maps/search"]');
    await expect(map).toHaveAttribute('href', /Persiaran%20KLCC/);
    await shot(page, 'FLOW-1-step-2-fields');

    // What the page must never say (§13.3).
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(CANARY.segment);
    expect(body).not.toContain(CANARY.contactEmail);
    expect(body).not.toContain(CANARY.contactPhone);
    expect(body).not.toContain(CANARY.partyMateName);
    expect(body).not.toContain(T.partyMate);
    expect(body).not.toMatch(/booklet|leave a note|public wall/i);
    expect(body).not.toContain('Checked in');

    // noindex — the token is the credential (§13.3).
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('is anonymous and mutates nothing', async ({ browser }) => {
    const before = await snapshot();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    expect((await ctx.cookies()).length).toBe(0);
    for (let i = 0; i < 3; i++) {
      const res = await page.goto(`/t/${T.issued}`);
      expect(res?.status()).toBe(200);
    }
    await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
    await shot(page, 'FLOW-1-step-3-anonymous');
    expect(await snapshot()).toEqual(before);
    await ctx.close();
  });

  test('fits a phone: single column, no horizontal scroll', async ({ page }) => {
    await page.goto(`/t/${T.issued}`);
    await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const qr = await page.locator('svg[shape-rendering="crispEdges"]').boundingBox();
    expect(qr!.width).toBeGreaterThan(150);
    expect(qr!.width).toBeLessThanOrEqual(390);
    await shot(page, 'FLOW-1-step-4-phone-viewport');
  });
});

test('FLOW-2  the QR on the page decodes to the printed ticket payload', async ({ page }) => {
  await page.goto(`/t/${T.issued}`);
  const svg = await page.locator('svg[shape-rendering="crispEdges"]').evaluate(
    (el) => el.outerHTML,
  );
  await shot(page, 'FLOW-2-step-1-qr-on-screen');
  const file = '/tmp/qa-i-qr.svg';
  writeFileSync(file, svg);
  // Decoded with @zxing, not re-encoded with `qrcode` — an independent reader.
  const decoded = execFileSync('node', ['qa/support/decode-qr.mjs', file]).toString();
  expect(decoded).toBe(`${APP_URL}/t/${T.issued}`);
});

test('FLOW-3  a stranger guesses a token', async ({ page }) => {
  const res = await page.goto(`/t/${T.unknown}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText('We could not find that ticket')).toBeVisible();
  await shot(page, 'FLOW-3-step-1-unknown-token');
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Aisyah|Admitted Guest|Marcus/);
  expect(body).not.toMatch(/at .*node_modules|node:internal|select .* from attendees/i);
});

test('FLOW-4  hostile input in the token segment', async ({ page }) => {
  const hostile = [
    ['sql', "'%20or%201%3D1--"],
    ['traversal', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['script', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
    ['nul', `${T.issued}%00`],
    ['long', 'A'.repeat(2000)],
  ] as const;
  let dialog = false;
  page.on('dialog', async (d) => {
    dialog = true;
    await d.dismiss();
  });
  for (const [name, value] of hostile) {
    const res = await page.goto(`/t/${value}`);
    expect(res?.status(), name).toBe(404);
    await expect(page.getByText('We could not find that ticket')).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body, name).not.toMatch(/node_modules|node:internal|postgres|syntax error/i);
    await shot(page, `FLOW-4-step-${name}`);
  }
  expect(dialog).toBe(false);
});

test('FLOW-5  a cancelled ticket says so, and withholds the QR', async ({ page }) => {
  const res = await page.goto(`/t/${T.cancelled}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText('This ticket is no longer valid')).toBeVisible();
  await expect(page.getByText('front desk')).toBeVisible();
  await expect(page.locator('svg[shape-rendering="crispEdges"]')).toHaveCount(0);
  await expect(page.getByText('Present this QR at the door')).toHaveCount(0);
  // Still says which show, so the desk has something to work with.
  await expect(page.getByRole('heading', { name: 'Evening Concert' })).toBeVisible();
  await shot(page, 'FLOW-5-step-1-cancelled');
});

test('FLOW-6  an admitted holder sees a checked-in badge, not a V2 portal', async ({ page }) => {
  await page.goto(`/t/${T.admitted}`);
  await expect(page.getByText('Checked in')).toBeVisible();
  await expect(page.getByText('Admitted Sat 19 Sep 2026, 19:12')).toBeVisible();
  await expect(page.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/booklet|leave a note|public wall/i);
  await shot(page, 'FLOW-6-step-1-admitted');
});

test('FLOW-7  a reverted check-in reads as not yet admitted', async ({ page }) => {
  await page.goto(`/t/${T.reverted}`);
  await expect(page.getByText('Present this QR at the door')).toBeVisible();
  await expect(page.getByText('Checked in')).toHaveCount(0);
  await shot(page, 'FLOW-7-step-1-reverted');
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from check_ins where reverted_at is not null`;
  expect(row.n).toBeGreaterThan(0);
});

test('FLOW-8  a guest with no name of their own still gets a ticket', async ({ page }) => {
  const res = await page.goto(`/t/${T.placeholder}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Guest of Booker Nurul')).toBeVisible();
  await expect(page.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
  await shot(page, 'FLOW-8-step-1-placeholder-name');
});

test('FLOW-9  the clock is the venue s, not the reader s', async ({ browser }) => {
  const read = async (timezoneId: string, label: string) => {
    const ctx = await browser.newContext({ timezoneId, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`/t/${T.admitted}`);
    await expect(page.getByText('Sat 19 Sep 2026', { exact: true })).toBeVisible();
    await shot(page, `FLOW-9-step-${label}`);
    const text = await page.locator('body').innerText();
    await ctx.close();
    return text;
  };
  const ny = await read('America/New_York', '1-new-york');
  const utc = await read('UTC', '2-utc');
  const kl = await read('Asia/Kuala_Lumpur', '3-kuala-lumpur');
  for (const [where, text] of [['NY', ny], ['UTC', utc], ['KL', kl]] as const) {
    expect(text, where).toContain('Doors open 19:00');
    expect(text, where).toContain('Starts 19:30');
    expect(text, where).toContain('Sat 19 Sep 2026');
    expect(text, where).toContain('Admitted Sat 19 Sep 2026, 19:12');
    // The reader's own clock must not appear: 07:00 in New York, 11:00 in UTC.
    expect(text, where).not.toContain('Doors open 07:00');
    expect(text, where).not.toContain('Doors open 11:00');
  }
});

test('FLOW-10a  the ticket itself works with JavaScript unavailable', async ({ browser }) => {
  const ctx = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto(`/t/${T.issued}`);
  await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
  await expect(page.getByText('Doors open 19:00')).toBeVisible();
  await expect(page.getByText('Dewan Filharmonik Petronas')).toBeVisible();
  await expect(page.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
  await expect(page.getByText(/Doors open in \d+ days?/)).toBeVisible();
  await shot(page, 'FLOW-10-step-1-no-javascript');
  await ctx.close();
});

/**
 * The sad half, and the one that fails.
 *
 * `notFound()` thrown inside the Server Component leaves an **empty `<body>`**
 * in the server-rendered HTML: the friendly page is only inside the RSC flight
 * payload, so it paints after hydration and never at all without JS. The happy
 * path is fully server-rendered (FLOW-10a), so this is specific to the
 * not-found branch — which is the branch this module exists for
 * (spec/v2.md §13.2, spec/surfaces.md §15.3).
 */
test('FLOW-10b  the not-found page with JavaScript unavailable', async ({ browser }) => {
  const ctx = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  const res = await page.goto(`/t/${T.unknown}`);
  expect(res?.status()).toBe(404);
  await shot(page, 'FLOW-10-step-2-not-found-no-javascript');
  const body = await page.locator('body').innerText();
  await ctx.close();
  expect(body, 'the friendly not-found copy must survive without JS').toContain(
    'We could not find that ticket',
  );
});

test('FLOW-11  a soft-deleted seat is indistinguishable from a token that never existed', async ({
  page,
}) => {
  const res = await page.goto(`/t/${T.deleted}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText('We could not find that ticket')).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('Deleted Guest');
  await shot(page, 'FLOW-11-step-1-soft-deleted');

  await page.goto(`/t/${T.unknown}`);
  const other = await page.locator('body').innerText();
  expect(other).toBe(body);
});

test('FLOW-12  portal_unlock_mode does not change the V1 page', async ({ page }) => {
  const readAll = async (label: string) => {
    await page.goto(`/t/${T.issued}`);
    await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
    await shot(page, `FLOW-12-step-${label}`);
    return page.locator('main').innerText();
  };
  await sql`update shows set portal_unlock_mode = 'CLOSED' where id = 1`;
  const closed = await readAll('1-closed');
  await sql`update shows set portal_unlock_mode = 'OPEN_TO_ALL' where id = 1`;
  const open = await readAll('2-open-to-all');
  await sql`update shows set portal_unlock_mode = 'ON_ADMISSION' where id = 1`;

  expect(closed).toContain('Present this QR at the door');
  // V1 has nothing behind the lock, so all three modes render the same screen.
  expect(open.replace(/in \d+ days?/, 'X')).toBe(closed.replace(/in \d+ days?/, 'X'));
  expect(open).not.toMatch(/booklet|leave a note|public wall/i);
});

test('FLOW-13  a waitlisted seat', async ({ page }) => {
  const res = await page.goto(`/t/${T.waitlisted}`);
  expect(res?.status()).toBe(200);
  await shot(page, 'FLOW-13-step-1-waitlisted');
  const body = await page.locator('body').innerText();
  const [row] = await sql<{ status: string }[]>`
    select status from attendees where qr_token = ${T.waitlisted}`;
  expect(row.status).toBe('WAITLIST');
  // Recorded rather than asserted either way: the door admits a WAITLIST row
  // green (src/lib/checkin/evaluate.ts only special-cases CANCELLED), so the
  // page agreeing with it is consistent. See the report's Note.
  expect(body).toContain('Present this QR at the door');
});

test('FLOW-14  an ADMIN session sees the same read-only page', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
  await shot(page, 'FLOW-14-step-1-signed-in');

  const before = await snapshot();
  await page.goto(`/t/${T.issued}`);
  await expect(page.getByText('Aisyah Binti Rahman')).toBeVisible();
  await shot(page, 'FLOW-14-step-2-same-page-as-admin');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(CANARY.contactEmail);
  expect(body).not.toContain(CANARY.segment);
  expect(body).not.toMatch(/Edit|Cancel ticket|Reissue/);
  expect(await snapshot()).toEqual(before);
  await ctx.close();
});

test.afterAll(async () => {
  await sql.end();
});
