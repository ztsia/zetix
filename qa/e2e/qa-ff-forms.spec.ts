/**
 * QA pass for `feat/form-field-types-and-preview` (modules K, L, M, V2 forms).
 * Fixtures: `qa/support/start-ff.sh` (seed `qa/support/seed-ff.mjs`) against zetix_qa.
 * Assert first, then screenshot. Where a click should write, the database is read back.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import postgres from 'postgres';

const OUT = 'qa-artifacts/feat-form-field-types-and-preview';
const SHOTS = `${OUT}/screens`;
mkdirSync(SHOTS, { recursive: true });
const seed = JSON.parse(readFileSync(`${OUT}/seed.json`, 'utf8')) as {
  concertId: number;
  allTypesFormId: number;
  draftFormId: number;
  closedFormId: number;
};
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
test.setTimeout(180_000);
test.afterAll(async () => {
  await sql.end();
});

const RUN = Date.now().toString(36);
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const builderUrl = (id: number) => `/admin/concerts/${seed.concertId}/forms/${id}`;

type Field = { key: string; label: string; type: string; required?: boolean; system?: boolean };
type Block = { id: string; type: string; fields?: Field[]; guest_fields?: Field[] };
async function formRow(id: number) {
  const [row] = await sql<
    {
      title: string;
      description_md: string | null;
      schema_version: number;
      max_responses: number | null;
      round_label: string | null;
      opens_at: Date | null;
      schema: { blocks: Block[] };
    }[]
  >`select title, description_md, schema_version, max_responses, round_label, opens_at, schema
      from registration_forms where id = ${id}`;
  return row;
}
const block = (s: { blocks: Block[] }, id: string) => s.blocks.find((b) => b.id === id)!;

async function adminPage(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  return { ctx, page };
}

test('FLOW-1 admin builds: duplicate, insert after open card, explicit save bumps version', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(builderUrl(seed.draftFormId));
  // step 1: frame
  for (const tab of ['Questions', 'Responses', 'Settings']) {
    await expect(page.getByRole('link', { name: new RegExp(`^${tab}`) }).first()).toBeVisible();
  }
  await expect(page.getByLabel('Preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy responder link' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Publish/ })).toBeVisible();
  await shot(page, 'FLOW-1-step-1-builder-frame');

  const before = await formRow(seed.draftFormId);
  // step 2: open "Short answer Q" and duplicate it
  await page.getByRole('button', { name: 'Edit Short answer Q' }).click();
  await page.getByRole('button', { name: 'Duplicate Short answer Q' }).click();
  await expect(page.getByRole('textbox', { name: 'Question', exact: true })).toHaveValue('Short answer Q');
  await expect(page.getByText('Short answer Q', { exact: true })).toHaveCount(1); // the idle original
  await shot(page, 'FLOW-1-step-2-duplicated');

  // step 3: add question after the open (duplicated) card
  await page.getByRole('button', { name: 'Add question' }).first().click();
  await shot(page, 'FLOW-1-step-3-added');

  // step 4: save
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText(`Saved as version ${before.schema_version + 1}`)).toBeVisible();
  await shot(page, 'FLOW-1-step-4-saved');
  const after = await formRow(seed.draftFormId);
  expect(after.schema_version).toBe(before.schema_version + 1);
  const labels = block(after.schema, 'extras').fields!.map((f) => f.label);
  expect(labels.slice(0, 4)).toEqual(['Short answer Q', 'Short answer Q', 'Untitled question', 'Paragraph Q']);
  const keys = block(after.schema, 'extras').fields!.map((f) => f.key);
  expect(new Set(keys).size).toBe(keys.length);
  await ctx.close();
});

test('FLOW-2 locked system field: only wording editable; saved schema keeps key/type/required', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(builderUrl(seed.draftFormId));
  await page.getByRole('button', { name: /^Edit Email/ }).first().click();
  await expect(page.getByRole('button', { name: /^Delete Email/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Duplicate Email/ })).toHaveCount(0);
  await expect(page.getByLabel('Answer type')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByText('Always required')).toBeVisible();
  await shot(page, 'FLOW-2-step-1-locked-email');

  await page.getByRole('textbox', { name: 'Question', exact: true }).fill('Your email address');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText(/Saved as version/)).toBeVisible();
  await shot(page, 'FLOW-2-step-2-saved-label');
  const row = await formRow(seed.draftFormId);
  const emails = block(row.schema, 'registrant').fields!.filter((f) => f.key === 'contact_email');
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({ label: 'Your email address', type: 'email', required: true, system: true });
  await ctx.close();
});

test('FLOW-3 header card: title saved without bumping schema_version; blank refused', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(builderUrl(seed.draftFormId));
  const before = await formRow(seed.draftFormId);
  await page.getByRole('button', { name: "Edit the form's title and description" }).click();
  await page.getByLabel('Form title').fill(`Header ${RUN}`);
  await page.getByLabel('Form description').fill('An intro');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText(/^Saved\.$/)).toBeVisible();
  await shot(page, 'FLOW-3-step-1-header-saved');
  let row = await formRow(seed.draftFormId);
  expect(row.title).toBe(`Header ${RUN}`);
  expect(row.description_md).toBe('An intro');
  expect(row.schema_version).toBe(before.schema_version);

  const hdr = page.getByRole('button', { name: "Edit the form's title and description" });
  if (await hdr.count()) await hdr.click();
  await page.getByLabel('Form title').fill('   ');
  // Refused on the client (Save disabled); the server refusal is tests/forms/form-actions.test.ts.
  await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  await shot(page, 'FLOW-3-step-2-blank-refused');
  row = await formRow(seed.draftFormId);
  expect(row.title).toBe(`Header ${RUN}`);
  await ctx.close();
});

test('FLOW-3b hostile description renders as text on /f/{slug}', async ({ page }) => {
  await page.goto('/f/qa-all-types');
  await expect(page.getByText('Short answer Q')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('script:has-text("__xss")').count()).toBe(0);
  await shot(page, 'FLOW-3-step-3-no-xss');
});

test('FLOW-4 settings: folded group still posts; times on venue clock', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser, { timezoneId: 'America/New_York' });
  await page.goto(`${builderUrl(seed.draftFormId)}/settings`);
  await expect(page.getByLabel('Maximum responses')).toHaveValue('77');
  await shot(page, 'FLOW-4-step-1-settings');
  // fold Responses
  await page.getByRole('button', { name: /^Responses/ }).click();
  await expect(page.getByLabel('Maximum responses')).toBeHidden();
  await page.getByLabel('Opens').fill('2026-10-01T09:00');
  await page.getByLabel('Round').fill(`R-${RUN}`);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await shot(page, 'FLOW-4-step-2-saved-folded');
  const row = await formRow(seed.draftFormId);
  expect(row.max_responses).toBe(77);
  expect(row.round_label).toBe(`R-${RUN}`);
  // Asia/Singapore 09:00 = 01:00Z
  expect(row.opens_at!.toISOString()).toBe('2026-10-01T01:00:00.000Z');
  await ctx.close();
});

test('FLOW-4b settings save in a stale tab does not undo a header edit', async ({ browser }) => {
  const { ctx, page: settings } = await adminPage(browser);
  await settings.goto(`${builderUrl(seed.draftFormId)}/settings`);
  await expect(settings.getByRole('button', { name: 'Save settings' })).toBeVisible();

  const builder = await ctx.newPage();
  await builder.goto(builderUrl(seed.draftFormId));
  await builder.getByRole('button', { name: "Edit the form's title and description" }).click();
  await builder.getByLabel('Form title').fill(`Newer title ${RUN}`);
  await builder.getByRole('button', { name: /^Save$/ }).click();
  await expect(builder.getByText(/^Saved\.$/)).toBeVisible();
  expect((await formRow(seed.draftFormId)).title).toBe(`Newer title ${RUN}`);

  await settings.getByLabel('Round').fill(`Stale-${RUN}`);
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('Settings saved.')).toBeVisible();
  await shot(settings, 'FLOW-4-step-3-stale-settings-save');
  const row = await formRow(seed.draftFormId);
  console.log('TITLE AFTER STALE SETTINGS SAVE:', JSON.stringify(row.title));
  expect(row.title).toBe(`Newer title ${RUN}`);
  await ctx.close();
});

test('FLOW-5 preview: unsaved draft shown, submit writes nothing, strangers refused', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(builderUrl(seed.draftFormId));
  await page.getByRole('button', { name: 'Edit Paragraph Q' }).click();
  await page.getByRole('textbox', { name: 'Question', exact: true }).fill(`Unsaved ${RUN}`);
  await shot(page, 'FLOW-5-step-1-unsaved-edit');

  const preview = await ctx.newPage();
  await preview.goto(`/preview/${seed.draftFormId}`);
  await expect(preview.getByText('Showing your unsaved changes.')).toBeVisible();
  await expect(preview.getByText(`Unsaved ${RUN}`)).toBeVisible();
  // no admin chrome
  await expect(preview.getByText('Toggle Sidebar')).toHaveCount(0);
  await shot(preview, 'FLOW-5-step-2-preview-draft');

  const count = async () =>
    (await sql<{ n: number }[]>`select (select count(*) from form_responses)::int + (select count(*) from registrations)::int as n`)[0].n;
  const n0 = await count();
  await preview.locator('input[id="registrant.contact_name"]').fill('Preview Person');
  await preview.locator('input[id="registrant.contact_email"]').fill('p@example.com');
  const submit = preview.getByRole('button', { name: /^Submit$/ });
  await expect(submit).toBeDisabled();
  await expect(preview.getByText('Nothing is sent from a preview.')).toBeVisible();
  console.log('PREVIEW <form> elements:', await preview.locator('form').count());
  await preview.keyboard.press('Enter'); // implicit submission from the focused email input
  await preview.waitForTimeout(1500);
  expect(await count()).toBe(n0);
  await expect(preview).toHaveURL(new RegExp(`/preview/${seed.draftFormId}$`));
  await shot(preview, 'FLOW-5-step-3-submit-inert');

  // Leave the builder without saving so the draft key does not linger for later flows.
  page.on('dialog', (d) => d.accept());
  await ctx.close();

  const anon = await browser.newPage();
  await anon.goto(`/preview/${seed.draftFormId}`);
  await expect(anon).toHaveURL(/\/login/);
  await expect(anon.getByText('Short answer Q')).toHaveCount(0);
  await shot(anon, 'FLOW-5-step-4-anonymous-refused');
  await anon.close();
});

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test('FLOW-6 stranger registers on a phone with every field type', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  await page.goto('/f/qa-all-types');
  await expect(page.getByText('Section 1 of 3')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'FLOW-6-step-1-phone-form');

  const email = `phone-${RUN}@example.com`;
  await page.locator('[id="registrant.contact_name"]').fill('Phone Tan');
  await page.locator('[id="registrant.contact_email"]').fill(email);
  await expect(page.getByRole('button', { name: 'Bring someone else' })).toBeVisible();
  await page.locator('[id="party.0.full_name"]').fill('Guest Tan');
  await page.locator('[id="extras.q_text"]').fill("O'Brien; drop table x --");
  await page.getByRole('radio', { name: 'Sound: Good' }).check();
  await page.getByRole('radio', { name: 'Seats: Bad' }).check();
  await page.locator('label[for="extras.q_rating.4"]').click();
  await page.locator('[id="extras.q_time"]').fill('19:30');
  await page.getByRole('checkbox', { name: 'Mon: PM' }).check();
  await shot(page, 'FLOW-6-step-2-filled');
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await page.waitForURL(/\/done/);
  await expect(page.getByText('Thank you, Phone Tan')).toBeVisible();
  await expect(page.getByText('2 seats confirmed')).toBeVisible();
  // concert.timezone Asia/Singapore, browser America/Los_Angeles: 11:30Z must read 19:30
  await expect(page.getByText(/Sat 19 Sep 2026, 19:30/)).toBeVisible();
  await shot(page, 'FLOW-6-step-3-confirmation');

  const party = await sql<{ full_name: string; allocation_type: string; status: string }[]>`
    select a.full_name, a.allocation_type::text, a.status::text from attendees a
      join registrations r on r.id = a.registration_id where r.contact_email = ${email} order by a.id`;
  expect(party.map((p) => p.full_name)).toEqual(['Phone Tan', 'Guest Tan']);
  expect(party.every((p) => p.allocation_type === 'EXTRA')).toBe(true);
  const [resp] = await sql<{ raw: Record<string, unknown>; custom: Record<string, unknown> }[]>`
    select fr.raw, r.custom from registrations r join form_responses fr on fr.id = r.form_response_id
     where r.contact_email = ${email}`;
  console.log('RAW', JSON.stringify(resp.raw));
  console.log('CUSTOM', JSON.stringify(resp.custom));
  expect(resp.custom.q_grid).toEqual({ sound: 'good', seats: 'bad' });
  expect(resp.custom.q_gridc).toEqual({ mon: ['pm'] });
  expect(resp.custom.q_time).toBe('19:30');
  expect(resp.custom.q_rating).toBe(4);
  expect(resp.custom.q_text).toBe("O'Brien; drop table x --");
  await ctx.close();
});

test('FLOW-7 required grid with a row missing is refused, nothing written', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/f/qa-all-types');
  const email = `grid-${RUN}@example.com`;
  await page.locator('[id="registrant.contact_name"]').fill('Grid Tan');
  await page.locator('[id="registrant.contact_email"]').fill(email);
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('radio', { name: 'Sound: Good' }).check();
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/f\/qa-all-types$/);
  const err = page.locator('[aria-invalid="true"], [role="alert"], .text-destructive').first();
  await expect(err).toBeVisible();
  await shot(page, 'FLOW-7-step-1-grid-refused');
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from registrations where contact_email = ${email}`;
  expect(n).toBe(0);
  await ctx.close();
});

test('FLOW-8 Clear form sits behind a confirm', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/f/qa-all-types');
  const name = page.locator('[id="registrant.contact_name"]');
  await name.fill('Clear Tan');
  await page.getByRole('button', { name: 'Clear form' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await shot(page, 'FLOW-8-step-1-confirm');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(name).toHaveValue('Clear Tan');
  await shot(page, 'FLOW-8-step-2-cancel-kept');
  await page.getByRole('button', { name: 'Clear form' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear form' }).click();
  await expect(name).toHaveValue('');
  await shot(page, 'FLOW-8-step-3-cleared');
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from registrations where contact_name = 'Clear Tan'`;
  expect(n).toBe(0);
  await ctx.close();
});

test('FLOW-9 closed form shows the closed state, not the form', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/f/qa-closed');
  await expect(page.getByRole('button', { name: /^Submit$/ })).toHaveCount(0);
  await expect(page.getByText(/closed|not available|not open/i).first()).toBeVisible();
  await shot(page, 'FLOW-9-step-1-closed');
  await ctx.close();
});

test('FLOW-10 an operator cannot reach form admin or the preview', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill('Wei Ling');
  await page.getByLabel('Access code').fill('qa-op-code');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/scan/login'));
  await shot(page, 'FLOW-10-step-1-operator-signed-in');

  await page.goto(builderUrl(seed.draftFormId));
  await expect(page.getByText('Short answer Q')).toHaveCount(0);
  console.log('OPERATOR builder URL', page.url());
  await shot(page, 'FLOW-10-step-2-builder-refused');

  const res = await page.goto(`/preview/${seed.draftFormId}`);
  console.log('OPERATOR preview URL', page.url(), res?.status());
  await expect(page.getByText('Short answer Q')).toHaveCount(0);
  await shot(page, 'FLOW-10-step-3-preview-refused');
  await ctx.close();
});

test('FLOW-4c one tab: header saved, then Settings tab link, then Save settings keeps the title', async ({ browser }) => {
  const { ctx, page } = await adminPage(browser);
  await page.goto(`${builderUrl(seed.draftFormId)}/settings`);
  await page.locator(`a[href$="/forms/${seed.draftFormId}"]`).first().click();
  await page.waitForURL(new RegExp(`/forms/${seed.draftFormId}$`));
  await page.getByRole('button', { name: "Edit the form's title and description" }).click();
  await page.getByLabel('Form title').fill(`Single tab ${RUN}`);
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText(/^Saved\.$/)).toBeVisible();
  await page.locator(`a[href$="/forms/${seed.draftFormId}/settings"]`).first().click();
  await page.waitForURL(/\/settings$/);
  await page.getByLabel('Round').fill(`One-${RUN}`);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await shot(page, 'FLOW-4-step-4-single-tab-settings-save');
  const row = await formRow(seed.draftFormId);
  console.log('TITLE AFTER SINGLE-TAB SETTINGS SAVE:', JSON.stringify(row.title));
  expect(row.title).toBe(`Single tab ${RUN}`);
  await ctx.close();
});
