import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * `fix/import-reimport-dedup` — module C, import.md §9.2.
 * Flows from qa-artifacts/fix-import-reimport-dedup/02-flows.md.
 */
const SHOTS = 'qa-artifacts/fix-import-reimport-dedup/screens';
const TMP = '/tmp/claude-0/-home-user-zetix/6dc0424c-e3d4-537c-983e-0dd062ead431/scratchpad/sheets';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(TMP, { recursive: true });

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
test.afterAll(async () => {
  await sql.end();
});

const HEADERS = 'Timestamp,Contact Name,Contact Email,Attendee Name,Attendee Email,Ticket Type';

function csv(name: string, rows: string[]): string {
  const path = `${TMP}/${name}`;
  writeFileSync(path, [HEADERS, ...rows].join('\n'), 'utf8');
  return path;
}

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

async function ids() {
  const [c] = await sql<{ id: number }[]>`select id from concerts where slug = 'qa-concert'`;
  return { concertId: Number(c.id) };
}

async function clearImports() {
  await sql`delete from email_outbox`;
  await sql`delete from attendees`;
  await sql`delete from registrations`;
  await sql`delete from import_batches`;
}

async function dbCounts() {
  const [r] = await sql<{ regs: string; seats: string }[]>`
    select (select count(*) from registrations where deleted_at is null) as regs,
           (select count(*) from attendees where deleted_at is null) as seats
  `;
  return { regs: Number(r.regs), seats: Number(r.seats) };
}

/** Walks the prepare/upload/sheet steps and lands on the mapping step. */
async function toMapping(
  page: Page,
  opts: { concertId: number; segmentName: string; file: string },
) {
  await page.goto(`/admin/concerts/${opts.concertId}/import`);
  await expect(page.getByRole('heading', { name: 'Spreadsheet import' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: new RegExp(opts.segmentName) }).click();
  await page.setInputFiles('#file', opts.file);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function toDryRun(
  page: Page,
  opts: { concertId: number; segmentName: string; file: string },
) {
  await toMapping(page, opts);
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText(/rows → /)).toBeVisible({ timeout: 20000 });
}

async function commit(page: Page, segmentName: string) {
  await page.getByRole('button', { name: /^Commit/ }).click();
  await expect(page.getByRole('heading', { name: 'This cannot be undone' })).toBeVisible();
  await page.getByLabel(/Type/).fill(segmentName);
  await page.getByRole('button', { name: 'Import' }).click();
}

const PUBLIC = 'Public Block';

const ROUND1 = [
  '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,alice@example.com,Extra',
  '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Bob Tan,bob@example.com,Extra',
  '2026-08-02T09:30:00Z,Carol Ng,carol@example.com,Carol Ng,carol@example.com,Extra',
];
const APPENDED = [
  ...ROUND1,
  '2026-08-09T14:00:00Z,Dan Wee,dan@example.com,Dan Wee,dan@example.com,Extra',
  '2026-08-09T14:00:00Z,Dan Wee,dan@example.com,Eve Wee,eve@example.com,Extra',
];

test.describe.configure({ mode: 'serial' });

test('FLOW-1 round 1 — a clean first import', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-1-logged-in.png`, fullPage: true });

  const file = csv('round1.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });

  await expect(page.getByText('3 rows → 2 registrations')).toBeVisible();
  await expect(page.getByText(/already imported/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-2-dry-run.png`, fullPage: true });

  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-3-committed.png`, fullPage: true });

  expect(await dbCounts()).toEqual({ regs: 2, seats: 3 });
});

test('FLOW-3 the identical sheet re-uploaded, nothing new', async ({ page }) => {
  const { concertId } = await ids();
  const before = await dbCounts();
  const tokensBefore = await sql<
    { qr_token: string; ticket_code: string }[]
  >`select qr_token, ticket_code from attendees order by id`;
  await loginAdmin(page);

  const file = csv('round1.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });

  // §9.2: "12 registrations, 12 already imported, 0 new"
  await expect(page.getByText('2 already imported · 0 new')).toBeVisible();
  await expect(page.getByText(/was imported into this segment already/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-1-already-imported.png`, fullPage: true });

  // §9.2 makes the skip INFO and "never blocking", but a fully-skipped run
  // leaves Commit disabled — `liveParties(...).length === 0` is the same dead
  // end a fully *blocked* run reaches. Recorded as observed.
  const commitBtn = page.getByRole('button', { name: /^Commit/ });
  await expect(commitBtn).toHaveText(/Commit 0 registrations/);
  const enabled = await commitBtn.isEnabled();
  // eslint-disable-next-line no-console
  console.log('FLOW-3 Commit button enabled on a fully-skipped run:', enabled);
  await expect(commitBtn).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Blocking 0' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-2-commit-disabled.png`, fullPage: true });

  // Nothing was written either way, which is the property that matters.
  expect(await dbCounts()).toEqual(before);
  const tokensAfter = await sql<
    { qr_token: string; ticket_code: string }[]
  >`select qr_token, ticket_code from attendees order by id`;
  expect(tokensAfter).toEqual(tokensBefore);
});

test('FLOW-2 round 2 — the same sheet with new rows appended', async ({ page }) => {
  const { concertId } = await ids();
  await loginAdmin(page);

  const file = csv('round2.csv', APPENDED);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });

  await expect(page.getByText('5 rows → 3 registrations')).toBeVisible();
  await expect(page.getByText('2 already imported · 1 new')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-1-two-old-one-new.png`, fullPage: true });

  // Skipped seats must leave the seat prediction (§9.4).
  await expect(page.getByText(/2 confirm/)).toBeVisible();

  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(
    /Commit 1 registrations/,
  );
  await page.getByRole('button', { name: /^Commit/ }).click();
  await expect(page.getByRole('heading', { name: 'This cannot be undone' })).toBeVisible();
  await expect(page.getByText(/2 parties are already imported and will be skipped/)).toBeVisible();
  await expect(page.getByText(/1 registrations and 2 attendees will be created/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-2-confirm-dialog.png`, fullPage: true });
  await page.getByLabel(/Type/).fill(PUBLIC);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-3-committed.png`, fullPage: true });

  expect(await dbCounts()).toEqual({ regs: 3, seats: 5 });
  const [dan] = await sql<
    { contact_email: string; seats: string }[]
  >`select r.contact_email::text, count(a.id) as seats from registrations r
      join attendees a on a.registration_id = r.id
     where r.contact_email = 'dan@example.com' group by r.contact_email`;
  expect(Number(dan.seats)).toBe(2);
});

test('FLOW-4 a party that grew since it was imported', async ({ page }) => {
  const { concertId } = await ids();
  await loginAdmin(page);

  const grown = csv('grown.csv', [
    ...APPENDED,
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Cara Tan,cara@example.com,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: grown });

  await expect(page.getByText(/was imported with 2 seats, but this file gives 3/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-1-size-changed.png`, fullPage: true });

  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(
    /Commit 0 registrations/,
  );
  expect(await dbCounts()).toEqual({ regs: 3, seats: 5 });
});

test('FLOW-5 a party with no contact email, twice', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const rows = ['2026-08-01T10:00:00Z,Fay Goh,,Fay Goh,fay@example.com,Extra'];
  const file = csv('noemail.csv', rows);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText(/cannot be grouped with any other/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-1-first-run.png`, fullPage: true });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText(/cannot be grouped with any other/)).toBeVisible();
  await expect(page.getByText(/already imported/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(
    /Commit 1 registrations/,
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-2-second-run.png`, fullPage: true });
});

test('FLOW-8 a blocking row alongside a skipped party', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const first = csv('f8-first.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: first });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  const before = await dbCounts();

  const mixed = csv('f8-mixed.csv', [
    ...ROUND1,
    'not-a-date,Gus Koh,gus@example.com,Gus Koh,gus@example.com,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: mixed });
  await expect(page.getByRole('button', { name: 'Blocking 1' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-8-step-1-blocking-and-skip.png`, fullPage: true });

  // The toolbar counts one blocking finding. Does the per-row table show it?
  await page.getByRole('button', { name: 'Blocking 1' }).click();
  const blockingRows = page.locator('tbody tr');
  // eslint-disable-next-line no-console
  console.log('FLOW-8 rows under the Blocking filter:', await blockingRows.count());
  // eslint-disable-next-line no-console
  console.log('FLOW-8 blocking table text:', (await blockingRows.allInnerTexts()).join(' | '));
  await page.screenshot({ path: `${SHOTS}/FLOW-8-step-2-blocking-filter.png`, fullPage: true });
  await page.getByRole('button', { name: /^All / }).click();

  const commitBtn = page.getByRole('button', { name: /^Commit/ });
  const enabled = await commitBtn.isEnabled();
  // eslint-disable-next-line no-console
  console.log('FLOW-8 commit button enabled with a row-level blocking finding:', enabled);
  if (enabled) {
    await commitBtn.click();
    await page.getByLabel(/Type/).fill(PUBLIC);
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText(/blocking/i).first()).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/FLOW-8-step-3-server-refusal.png`, fullPage: true });
  }
  expect(await dbCounts()).toEqual(before);
});

test('FLOW-10 re-import after an admin deleted the party', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const file = csv('f10.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  // §7.6: delete is the remedy for "a duplicate import".
  await sql`update attendees set deleted_at = now() where registration_id in
    (select id from registrations where contact_email = 'alice@example.com')`;
  await sql`update registrations set deleted_at = now() where contact_email = 'alice@example.com'`;

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText('1 already imported · 1 new')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(
    /Commit 1 registrations/,
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-1-deleted-is-new-again.png`, fullPage: true });
});

test('FLOW-11 re-import after a cancellation', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const file = csv('f11.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  const [alice] = await sql<{ id: number }[]>`
    select id from registrations where contact_email = 'alice@example.com'`;
  await page.goto(`/admin/concerts/${concertId}/registrations`);
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-1-registrations.png`, fullPage: true });

  // Cancel through the API the console uses, then re-upload the cumulative sheet.
  await sql`update attendees set status = 'CANCELLED' where registration_id = ${alice.id}`;
  await sql`update registrations set status = 'CANCELLED' where id = ${alice.id}`;

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  const skipLine = page.getByText(/already imported ·/);
  // eslint-disable-next-line no-console
  console.log(
    'FLOW-11 grouping line:',
    (await skipLine.count()) ? await skipLine.innerText() : '(no skip line rendered)',
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-2-cancelled-reimport.png`, fullPage: true });

  /**
   * A cancellation is an admin decision about a response that is already
   * imported, and §9.1 re-reads the sheet only for *new* responses — so the
   * party stays skipped and there is nothing to commit.
   *
   * This assertion was inverted when it was written: it demanded that one form
   * response end up holding two live registrations, which is the duplication
   * §9.2 exists to prevent. Because a cancellation "stays in the record and can
   * be restored" (allocation.md §7.9), restoring it would then have handed that
   * party two sets of tickets.
   */
  await expect(page.getByRole('button', { name: /Commit 0 registrations/ })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-3-nothing-to-commit.png`, fullPage: true });

  const live = await sql<{ id: string; status: string }[]>`
    select id, status from registrations
     where contact_email = 'alice@example.com' and deleted_at is null order by id`;
  // eslint-disable-next-line no-console
  console.log('FLOW-11 registrations for one form response:', JSON.stringify(live));
  expect(live.length).toBe(1);
  expect(live[0].status).toBe('CANCELLED');
});

test('FLOW-9 the same rows into a second segment', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const file = csv('f9.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  // Tiny Block is a PUBLIC segment on a different show — capacity 3, so the
  // three seats fit exactly.
  await toDryRun(page, { concertId, segmentName: 'Tiny Block', file });
  await expect(page.getByText(/already imported/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(
    /Commit 2 registrations/,
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-9-step-1-other-segment.png`, fullPage: true });
});


test('FLOW-13 every seat of a skipped party states its outcome', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const party3 = [
    '2026-08-01T10:00:00Z,Hana Sim,hana@example.com,Hana Sim,h1@example.com,Extra',
    '2026-08-01T10:00:00Z,Hana Sim,hana@example.com,Ivan Sim,h2@example.com,Extra',
    '2026-08-01T10:00:00Z,Hana Sim,hana@example.com,Jo Sim,h3@example.com,Extra',
  ];
  const file = csv('f13.csv', party3);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText('1 already imported · 0 new')).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  const texts = await rows.allInnerTexts();
  // eslint-disable-next-line no-console
  console.log('FLOW-13 per-row report of a skipped party of 3:');
  for (const t of texts) console.log('   ', JSON.stringify(t.replace(/\n/g, ' | ')));
  await page.screenshot({ path: `${SHOTS}/FLOW-13-step-1-per-row-outcomes.png`, fullPage: true });

  // §9.6 step 5: one row per sheet row, each carrying its outcome.
  for (const t of texts) expect(t).toMatch(/Skipped/);
});

test('FLOW-14 a blocking row while other parties are still live', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  const first = csv('f14-first.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: first });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  const before = await dbCounts();

  // One already-imported party, one brand-new valid party, one blocking row.
  const mixed = csv('f14-mixed.csv', [
    ...ROUND1,
    '2026-08-09T14:00:00Z,Dan Wee,dan@example.com,Dan Wee,dan@example.com,Extra',
    'not-a-date,Gus Koh,gus@example.com,Gus Koh,gus@example.com,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: mixed });
  await expect(page.getByRole('button', { name: 'Blocking 1' })).toBeVisible();

  const commitBtn = page.getByRole('button', { name: /^Commit/ });
  // eslint-disable-next-line no-console
  console.log(
    'FLOW-14 Commit label:', await commitBtn.innerText(),
    '| enabled:', await commitBtn.isEnabled(),
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-1-commit-enabled.png`, fullPage: true });

  if (await commitBtn.isEnabled()) {
    await commitBtn.click();
    await expect(page.getByRole('heading', { name: 'This cannot be undone' })).toBeVisible();
    await page.getByLabel(/Type/).fill(PUBLIC);
    await page.getByRole('button', { name: 'Import' }).click();
    const err = page.getByText(/blocking/i).first();
    await expect(err).toBeVisible({ timeout: 20000 });
    // eslint-disable-next-line no-console
    console.log('FLOW-14 server refusal:', await err.innerText());
    await page.screenshot({ path: `${SHOTS}/FLOW-14-step-2-server-refusal.png`, fullPage: true });
  }
  expect(await dbCounts()).toEqual(before);
});
