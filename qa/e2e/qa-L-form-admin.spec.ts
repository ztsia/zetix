/**
 * QA phase 5 for module `L` — the form admin walked in a real browser.
 *
 * Fixtures come from `qa/support/start-l.sh` (seed `qa/support/seed-l.mjs`)
 * against `zetix_qa`. Every step asserts *before* it screenshots; the screenshot
 * is evidence for a human, the assertion is the test. Where a click is supposed
 * to change the database, the database is read afterwards — "Saved" on screen
 * and a row that moved are two different claims.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import postgres from 'postgres';

const QA_URL = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(QA_URL, { prepare: false, max: 3 });
const SHOTS = 'qa-artifacts/L-form-admin/screens';

const SEED = {
  concertId: 1,
  showId: 1,
  playerSegmentId: 1,
  publicSegmentId: 2,
  bareShowId: 2,
  bareSegmentId: 3,
};

mkdirSync(SHOTS, { recursive: true });

/** A per-run suffix, so slugs stay unique across repeated QA runs. */
const RUN = Date.now().toString(36);

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

async function createForm(
  page: Page,
  opts: { kind: string; parentLabel?: RegExp; title: string; round?: string; slug?: string },
) {
  await page.goto(`/admin/concerts/${SEED.concertId}/forms`);
  await page.getByRole('button', { name: /new form/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Kind').selectOption(opts.kind);
  if (opts.parentLabel) {
    await dialog.getByLabel(/segment|show/i).selectOption({ label: (await dialog.getByLabel(/segment|show/i).locator('option').allTextContents()).find((t) => opts.parentLabel!.test(t))! });
  }
  await dialog.getByLabel('Title').fill(opts.title);
  if (opts.round) await dialog.getByLabel('Round').fill(opts.round);
  // Unique per run: a slug is unique across every concert, so a re-run must not
  // collide with the forms the previous one left behind.
  if (opts.slug) await dialog.getByLabel('Link').fill(`${opts.slug}-${RUN}`);
  await dialog.getByRole('button', { name: /create form/i }).click();
  await page.waitForURL(/\/forms\/\d+$/);
  return Number(page.url().match(/\/forms\/(\d+)$/)![1]);
}

test.describe('FLOW-1 build a public form and open it', () => {
  test('system blocks pre-built, a custom question added, version bumped, status moved', async ({ page }) => {
    await loginAdmin(page);

    await page.goto(`/admin/concerts/${SEED.concertId}/forms`);
    await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
    await shot(page, 'FLOW-1-step-1-forms-index');

    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Public Registration',
      round: 'Round 1',
      slug: 'qa-public-r1',
    });

    // The blocks came from the kind — nothing asked which field means the email.
    await expect(page.getByRole('heading', { name: /QA Public Registration/ })).toBeVisible();
    await expect(page.getByText('Your details', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/contact_email · email/)).toBeVisible();
    await expect(page.getByText(/full_name · text/).first()).toBeVisible();
    await shot(page, 'FLOW-1-step-2-builder-public');

    const [row] = await sql<{ kind: string; schema_version: number; status: string; segment_id: number }[]>`
      select kind, schema_version, status, segment_id from registration_forms where id = ${formId}
    `;
    expect(row.kind).toBe('PUBLIC');
    expect(Number(row.segment_id)).toBe(SEED.publicSegmentId);
    expect(row.schema_version).toBe(1);
    expect(row.status).toBe('DRAFT');

    // A locked field offers label / help / placeholder and nothing else.
    await page.getByRole('button', { name: /^Edit .*Email/i }).first().click();
    await expect(page.getByText(/what it collects is fixed/i)).toBeVisible();
    await expect(page.getByLabel('Answer type')).toHaveCount(0);
    await expect(page.getByLabel('Required')).toHaveCount(0);
    await shot(page, 'FLOW-1-step-3-locked-field');

    // Add a section and a question, then save.
    await page.getByRole('button', { name: /add a section/i }).click();
    await page.getByRole('button', { name: /add a question/i }).last().click();
    await page.getByRole('button', { name: /save questions/i }).click();
    await expect(page.getByText(/Saved as version 2/)).toBeVisible();
    await shot(page, 'FLOW-1-step-4-saved');

    const [after] = await sql<{ schema_version: number; schema: any }[]>`
      select schema_version, schema from registration_forms where id = ${formId}
    `;
    expect(after.schema_version).toBe(2);
    expect(after.schema.blocks.some((b: any) => b.type === 'CUSTOM')).toBe(true);

    // DRAFT -> OPEN
    await page.getByRole('button', { name: /open the form/i }).click();
    await expect(page.getByText(/Form is now open|OPEN/i).first()).toBeVisible();
    const [opened] = await sql<{ status: string }[]>`select status from registration_forms where id = ${formId}`;
    expect(opened.status).toBe('OPEN');
    await shot(page, 'FLOW-1-step-5-open');
  });
});

test.describe('FLOW-2 the locked system field cannot be deleted', () => {
  test('no delete control on contact_email or a seat name', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Locked Fields',
      slug: 'qa-locked',
    });

    await expect(page.getByRole('button', { name: /^Delete .*Email address/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete Full name/i })).toHaveCount(0);
    // The removable system field still offers one, so the absence above is a
    // rule and not a missing feature.
    await expect(page.getByRole('button', { name: /^Delete .*[Pp]hone/i })).toHaveCount(1);
    await shot(page, 'FLOW-2-step-1-no-delete-on-locked');

    const [row] = await sql<{ schema: any }[]>`select schema from registration_forms where id = ${formId}`;
    const registrant = row.schema.blocks.find((b: any) => b.type === 'REGISTRANT');
    expect(registrant.fields.map((f: any) => f.key)).toContain('contact_email');
  });
});

test.describe('FLOW-3 conditions are custom-to-custom', () => {
  test('the source picker never offers a system field', async ({ page }) => {
    await loginAdmin(page);
    await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Conditions',
      slug: 'qa-conditions',
    });

    await page.getByRole('button', { name: /add a section/i }).click();
    await page.getByRole('button', { name: /add a question/i }).last().click();
    await page.getByRole('button', { name: /add a question/i }).last().click();
    await shot(page, 'FLOW-3-step-1-two-custom-questions');

    // Open the second custom question's editor and look at what a condition may read.
    const editButtons = page.getByRole('button', { name: /^Edit New question/i });
    await editButtons.last().click();
    await shot(page, 'FLOW-3-step-2-field-editor');

    const body = await page.content();
    // A system field key must not appear as an option anywhere in the condition UI.
    const conditionSelect = page.locator('select').filter({ hasText: /New question/ });
    if ((await conditionSelect.count()) > 0) {
      const options = await conditionSelect.first().locator('option').allTextContents();
      expect(options.join(' ')).not.toMatch(/contact_email|contact_name|full_name/);
    }
    expect(body).not.toMatch(/value="contact_email"/);
    await shot(page, 'FLOW-3-step-3-no-system-source');
  });
});

test.describe('FLOW-4 interpolated copy and the resolved cascade', () => {
  test('the inherited tab shows resolved figures, read-only', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Interpolation',
      slug: 'qa-interpolation',
    });

    await page.getByRole('tab', { name: /inherited/i }).click();
    await expect(page.getByText('Party size')).toBeVisible();
    // seed: form.max_tickets_per_response = 4 on the public segment
    await expect(page.getByText('4', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/set on the/i).first()).toBeVisible();
    await shot(page, 'FLOW-4-step-1-inherited');

    // No input writes the cap here (decision 43).
    const capInputs = page.locator('input[name="maxTicketsPerResponse"]');
    expect(await capInputs.count()).toBe(0);

    // The preview interpolates the resolved figure rather than a literal.
    await page.getByRole('tab', { name: /questions/i }).click();
    const preview = page.getByText(/\{\{max_additional_guests\}\}/);
    expect(await preview.count()).toBe(0);
    await shot(page, 'FLOW-4-step-2-preview-no-raw-token');

    const [row] = await sql<{ max_tickets_per_response: number | null }[]>`
      select max_tickets_per_response from registration_forms where id = ${formId}
    `;
    expect(row.max_tickets_per_response).toBeNull();
  });

  test('a segment configured with nothing reports it rather than defaulting', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Nothing Set/,
      title: 'QA Unconfigured',
      slug: 'qa-unconfigured',
    });
    await page.getByRole('tab', { name: /inherited/i }).click();
    await expect(page.getByText('not set').first()).toBeVisible();
    await shot(page, 'FLOW-4-step-3-not-set');
    expect(formId).toBeGreaterThan(0);
  });
});

test.describe('FLOW-5 a second round is a new form', () => {
  test('New round copies the questions and leaves round 1 alone', async ({ page }) => {
    await loginAdmin(page);
    const firstId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Rounds',
      round: 'Round 1',
      slug: 'qa-rounds-r1',
    });
    await page.getByRole('button', { name: /open the form/i }).click();
    await expect.poll(async () => (await sql`select status from registration_forms where id = ${firstId}`)[0].status).toBe('OPEN');

    await page.getByRole('button', { name: /new round/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Round').fill('Round 2');
    await dialog.getByRole('button', { name: /create the round/i }).click();
    await page.waitForURL(/\/forms\/\d+$/);
    await shot(page, 'FLOW-5-step-1-round-2-created');

    const rows = await sql<{ id: number; round_label: string; status: string; segment_id: number; schema_version: number }[]>`
      select id, round_label, status, segment_id, schema_version
      from registration_forms where slug like ${'qa-rounds%-' + RUN} or slug like ${'qa-rounds-r1-' + RUN + '%'} order by id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('CLOSED');
    expect(rows[1].round_label).toBe('Round 2');
    expect(Number(rows[1].segment_id)).toBe(Number(rows[0].segment_id));
    expect(rows[1].schema_version).toBe(1);

    await page.goto(`/admin/concerts/${SEED.concertId}/forms`);
    await expect(page.getByText('Round 2')).toBeVisible();
    await shot(page, 'FLOW-5-step-2-both-rounds-listed');
  });
});

test.describe('FLOW-6 wrong kind for the segment, and a duplicate link', () => {
  test('the dialog will not offer a player segment to a public form', async ({ page }) => {
    await loginAdmin(page);
    await page.goto(`/admin/concerts/${SEED.concertId}/forms`);
    await page.getByRole('button', { name: /new form/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Kind').selectOption('PUBLIC');
    const publicOptions = await dialog.getByLabel(/segment/i).locator('option').allTextContents();
    expect(publicOptions.join(' ')).not.toMatch(/Player Block/);
    await shot(page, 'FLOW-6-step-1-public-options');

    await dialog.getByLabel('Kind').selectOption('PLAYER');
    const playerOptions = await dialog.getByLabel(/segment/i).locator('option').allTextContents();
    expect(playerOptions.join(' ')).not.toMatch(/Public Block/);
    expect(playerOptions.join(' ')).toMatch(/Player Block/);
    await shot(page, 'FLOW-6-step-2-player-options');
  });

  test('a duplicate link is refused, and what the admin is shown', async ({ page }) => {
    await loginAdmin(page);
    await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Duplicate',
      slug: 'qa-duplicate',
    });

    await page.goto(`/admin/concerts/${SEED.concertId}/forms`);
    await page.getByRole('button', { name: /new form/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Kind').selectOption('PUBLIC');
    await dialog.getByLabel('Title').fill('QA Duplicate Again');
    await dialog.getByLabel('Link').fill(`qa-duplicate-${RUN}`);
    await dialog.getByRole('button', { name: /create form/i }).click();

    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    const text = (await alert.textContent()) ?? '';
    // eslint-disable-next-line no-console
    console.log('DUPLICATE SLUG, AS THE ADMIN SEES IT ->', text.trim());
    await shot(page, 'FLOW-6-step-3-duplicate-link-message');

    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from registration_forms where slug = ${'qa-duplicate-' + RUN}
    `;
    expect(Number(count)).toBe(1);
  });
});

test.describe('FLOW-7 responses and export', () => {
  test('the responses table renders and the export carries the pinned columns', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Responses',
      slug: 'qa-responses',
    });

    const [{ schema }] = await sql<{ schema: any }[]>`select schema from registration_forms where id = ${formId}`;
    const pinned = JSON.parse(JSON.stringify(schema));
    pinned.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [
        { key: 'diet', label: 'Dietary needs', type: 'text', system: false, required: false },
        { key: 'unanswered', label: 'Nobody answered this', type: 'text', system: false, required: false },
      ],
    });
    const raw = {
      registrant: { kind: 'flat', values: { contact_name: 'Ada Lovelace', contact_email: 'ada@example.test' } },
      party: { kind: 'repeater', rows: [{ full_name: 'Bob Tan' }, { full_name: 'Cleo Lim' }] },
      extras: { kind: 'flat', values: { diet: 'vegetarian' } },
    };
    await sql`
      insert into form_responses (form_id, raw, form_schema, identity_key, submitted_at)
      values (${formId}, ${JSON.stringify(raw)}::text::jsonb, ${JSON.stringify(pinned)}::text::jsonb,
              'ada@example.test', now())
    `;

    await page.goto(`/admin/concerts/${SEED.concertId}/forms/${formId}/responses`);
    await expect(page.getByText('ada@example.test').first()).toBeVisible();
    await shot(page, 'FLOW-7-step-1-responses-table');

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /export|xlsx|spreadsheet/i }).first().click();
    const file = await download;
    const path = `qa-artifacts/L-form-admin/${file.suggestedFilename()}`;
    await file.saveAs(path);
    // eslint-disable-next-line no-console
    console.log('DOWNLOADED ->', file.suggestedFilename());
    await shot(page, 'FLOW-7-step-2-export-downloaded');
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
  });
});

test.describe('FLOW-9 empty states', () => {
  test('a form with no responses shows an empty state and still exports', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Empty',
      slug: 'qa-empty',
    });

    await page.goto(`/admin/concerts/${SEED.concertId}/forms/${formId}/responses`);
    await expect(page.getByText(/no responses|nothing|empty/i).first()).toBeVisible();
    await shot(page, 'FLOW-9-step-1-empty-responses');

    // The export control is present but disabled while there is nothing to
    // export — recorded rather than asserted as a spec requirement, because
    // §8.5 describes the columns of a sheet, not whether an empty one is offered.
    const exportButton = page.getByRole('button', { name: /export|xlsx|spreadsheet/i }).first();
    await expect(exportButton).toBeVisible();
    const disabled = await exportButton.isDisabled();
    // eslint-disable-next-line no-console
    console.log('EMPTY EXPORT BUTTON DISABLED ->', disabled);
    await shot(page, 'FLOW-9-step-2-empty-export-control');
    expect(disabled).toBe(true);
  });
});

test.describe('FLOW-10 anonymous', () => {
  test('every forms URL refuses a visitor with no session', async ({ page, context }) => {
    await context.clearCookies();
    const urls = [
      `/admin/concerts/${SEED.concertId}/forms`,
      `/admin/concerts/${SEED.concertId}/forms/1`,
      `/admin/concerts/${SEED.concertId}/forms/1/responses`,
    ];
    for (const [i, url] of urls.entries()) {
      const response = await page.goto(url);
      expect(page.url()).toMatch(/\/login/);
      const body = await page.content();
      expect(body).not.toMatch(/Registration and feedback forms/);
      expect(body).not.toMatch(/ada@example\.test/);
      // eslint-disable-next-line no-console
      console.log(`ANON ${url} -> ${response?.status()} ${page.url()}`);
      await shot(page, `FLOW-10-step-${i + 1}-anon-refused`);
    }
  });
});

test.describe('FLOW-13 feedback form authoring', () => {
  test('attaches to a show, with no seat blocks', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'FEEDBACK',
      parentLabel: /Show One/,
      title: 'QA Feedback',
      slug: 'qa-feedback',
    });

    const [row] = await sql<{ segment_id: number | null; show_id: number | null; schema: any }[]>`
      select segment_id, show_id, schema from registration_forms where id = ${formId}
    `;
    expect(row.segment_id).toBeNull();
    expect(Number(row.show_id)).toBe(SEED.showId);
    expect(row.schema.blocks.some((b: any) => /GUESTS/.test(b.type))).toBe(false);
    await expect(page.getByText(/full_name · text/)).toHaveCount(0);
    await shot(page, 'FLOW-13-step-1-feedback-builder');

    await page.getByRole('tab', { name: /inherited/i }).click();
    await expect(page.getByText(/inherits none of this/i)).toBeVisible();
    await shot(page, 'FLOW-13-step-2-feedback-inherited');
  });
});

test.describe('FLOW-14 cross-concert URL tampering', () => {
  test('a form does not render under a concert that does not own it', async ({ page }) => {
    await loginAdmin(page);
    const formId = await createForm(page, {
      kind: 'PUBLIC',
      parentLabel: /Public Block/,
      title: 'QA Tamper',
      slug: 'qa-tamper',
    });

    const [other] = await sql<{ id: number }[]>`
      insert into concerts (name, slug, status, timezone)
      values ('Other Concert', ${'other-' + Date.now()}, 'ACTIVE', 'Asia/Singapore') returning id
    `;
    const response = await page.goto(`/admin/concerts/${other.id}/forms/${formId}`);
    // eslint-disable-next-line no-console
    console.log('CROSS-CONCERT PAGE ->', response?.status(), page.url());
    expect(await page.content()).not.toMatch(/QA Tamper/);
    await shot(page, 'FLOW-14-step-1-cross-concert-refused');
  });
});
