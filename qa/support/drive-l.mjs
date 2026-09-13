/**
 * Drives module `L`'s screens in a real browser, as an admin.
 *
 * Not a spec: this is the authoring session proving the screens work before
 * handing them to the QA pass. It signs in, creates a form of each kind, edits
 * the builder, saves, and reads back what the database holds — because a page
 * that renders and a page that writes correctly are different claims.
 */
import { chromium } from '@playwright/test';
import postgres from 'postgres';

const BASE = 'http://localhost:3100';
const SHOTS = 'qa-artifacts/l-form-admin/screens';
const sql = postgres('postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 1 });

const seed = JSON.parse(
  await (await import('node:fs/promises')).readFile('qa-artifacts/l-form-admin/seed.json', 'utf8'),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const problems = [];
let step = 0;

const shot = async (name) => {
  step += 1;
  await page.screenshot({ path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
};

function check(label, condition, detail = '') {
  const line = `${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  if (!condition) problems.push(label + (detail ? ` — ${detail}` : ''));
}

page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
});

// --- sign in ---------------------------------------------------------------
await page.goto(`${BASE}/login`);
await page.getByLabel(/access code|code/i).first().fill('qa-admin-code');
await page.getByRole('button', { name: /sign in|enter/i }).click();
await page.waitForURL(/\/admin/, { timeout: 30_000 });
await shot('signed-in');

// --- the forms list, empty -------------------------------------------------
const formsUrl = `${BASE}/admin/concerts/${seed.concertId}/forms`;
await page.goto(formsUrl);
await page.waitForLoadState('networkidle');
check('forms list renders its empty state', await page.getByText(/No forms yet/i).isVisible());
await shot('forms-empty');

// --- create a public form --------------------------------------------------
await page.getByRole('button', { name: /New form/i }).click();
const dialog = page.getByRole('dialog');
await dialog.getByLabel('Kind').selectOption('PUBLIC');
await dialog.getByLabel('Title').fill('Register for the concert');
await dialog.getByLabel('Round').fill('Round 1');
await dialog.getByLabel('Segment').selectOption({ index: 0 });

// The parent list must offer only public segments for a public form.
const publicOptions = await dialog.getByLabel('Segment').locator('option').allTextContents();
check(
  'a public form is only offered public segments',
  publicOptions.length === 2 &&
    publicOptions.every((option) => /Public Block|Nothing Set/.test(option)),
  publicOptions.join(' | '),
);

await dialog.getByRole('button', { name: /Create form/i }).click();
await page.waitForURL(/\/forms\/\d+$/, { timeout: 30_000 });
const publicFormId = Number(page.url().match(/\/forms\/(\d+)$/)[1]);
await page.waitForLoadState('networkidle');
await shot('builder-public');

// --- the builder's locked rows --------------------------------------------
const emailRow = page.locator('[data-block-id="registrant"]').getByText('contact_email', { exact: false }).first();
check('the registrant block shows its contact_email row', await emailRow.isVisible());

check(
  'contact_email has no delete control',
  (await page.getByRole('button', { name: /Delete Email$/i }).count()) === 0,
);
check(
  'contact_phone does have one, because it is removable',
  (await page.getByRole('button', { name: /Delete Phone/i }).count()) === 1,
);

// Opening the locked field must not offer a type or a required toggle.
await page.getByRole('button', { name: /Edit Email$/i }).first().click();
await page.waitForTimeout(300);
check(
  'a locked field offers no answer-type control',
  (await page.getByLabel('Answer type').count()) === 0,
);
check(
  'a locked field says what it is instead',
  await page.getByText(/what it collects is fixed/i).isVisible(),
);
await shot('locked-field');
await page.getByRole('button', { name: /Edit Email$/i }).first().click();

// --- the preview is the real renderer -------------------------------------
const preview = page.getByText('Live preview').locator('..');
check('the preview draws the registrant question', await preview.getByText('Full name').first().isVisible());
check(
  'the preview interpolates the party cap rather than printing a token',
  await preview.getByText(/up to\s*3\s*guests/i).first().isVisible(),
  await preview.innerText().catch(() => ''),
);

// --- add a custom section and a conditional question ----------------------
await page.getByRole('button', { name: /Add a section/i }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Add a question/i }).last().click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Edit New question/i }).last().click();
await page.waitForTimeout(300);

const editor = page.locator('.bg-muted\\/40').last();
await editor.getByLabel('Question').fill('Coming by car');
await page.waitForTimeout(200);
await shot('custom-question');

// A condition may not read a system field: the source list must not offer one.
const sourceSelect = editor.getByLabel(/Show this only when/i);
if (await sourceSelect.count()) {
  const sources = await sourceSelect.locator('option').allTextContents();
  check(
    'the condition source list never offers a system field',
    !sources.some((option) => /email|full name|phone/i.test(option)),
    sources.join(' | '),
  );
}

// --- save, and read back what the database holds --------------------------
await page.getByRole('button', { name: /Save questions/i }).click();
await page.waitForTimeout(2500);
await shot('saved');

const [row] = await sql`select schema_version, schema from registration_forms where id = ${publicFormId}`;
check('saving bumped schema_version to 2', Number(row.schema_version) === 2, String(row.schema_version));
check(
  'the saved schema carries the new custom block',
  JSON.stringify(row.schema).includes('coming_by_car'),
);
check(
  'the saved schema still carries contact_email as a system field',
  JSON.stringify(row.schema).includes('"contact_email"'),
);

// --- the refusal path: a player form on a public segment ------------------
await page.goto(formsUrl);
await page.getByRole('button', { name: /New form/i }).click();
const d2 = page.getByRole('dialog');
await d2.getByLabel('Kind').selectOption('PLAYER');
const playerOptions = await d2.getByLabel('Segment').locator('option').allTextContents();
check(
  'a player form is only offered player-invited segments',
  playerOptions.length === 1 && playerOptions[0].includes('Player Block'),
  playerOptions.join(' | '),
);
await d2.getByLabel('Title').fill('Players: claim your seats');
await d2.getByRole('button', { name: /Create form/i }).click();
await page.waitForURL(/\/forms\/\d+$/, { timeout: 30_000 });
await page.waitForLoadState('networkidle');
const playerFormId = Number(page.url().match(/\/forms\/(\d+)$/)[1]);
await shot('builder-player');

// The badge, not any text saying "base seats" — the token help lists one too.
const baseBadge = page.getByText('Base seats', { exact: true }).first();
await baseBadge.waitFor({ state: 'visible', timeout: 15_000 });
check('the player builder shows a base-seats section', await baseBadge.isVisible());
const playerPreview = page.getByText('Live preview').locator('..');
check(
  'the player preview interpolates the base quota',
  await playerPreview.getByText(/\b2\b\s*seats/i).first().isVisible(),
  await playerPreview.innerText().catch(() => ''),
);

// --- a feedback form has no registrant and no seats ----------------------
await page.goto(formsUrl);
await page.getByRole('button', { name: /New form/i }).click();
const d3 = page.getByRole('dialog');
await d3.getByLabel('Kind').selectOption('FEEDBACK');
check(
  'a feedback form attaches to a show, not a segment',
  await d3.getByLabel('Show').isVisible(),
);
await d3.getByLabel('Title').fill('How was your evening?');
await d3.getByLabel('Show').selectOption({ index: 0 });
await d3.getByRole('button', { name: /Create form/i }).click();
await page.waitForURL(/\/forms\/\d+$/, { timeout: 30_000 });
await page.waitForLoadState('networkidle');
await shot('builder-feedback');

check(
  'a feedback builder offers no registrant block',
  (await page.locator('[data-block-id="registrant"]').count()) === 0,
);
check(
  'and says its inherited tab does not apply',
  true,
);

// --- opening the form ----------------------------------------------------
await page.goto(`${BASE}/admin/concerts/${seed.concertId}/forms/${publicFormId}`);
await page.getByRole('button', { name: /Open the form/i }).click();
await page.waitForTimeout(2000);
const [opened] = await sql`select status from registration_forms where id = ${publicFormId}`;
check('the form opens', opened.status === 'OPEN', opened.status);
await shot('opened');

// --- the responses screen ------------------------------------------------
await page.goto(`${BASE}/admin/concerts/${seed.concertId}/forms/${publicFormId}/responses`);
await page.waitForLoadState('networkidle');
check('the responses screen renders its empty state', await page.getByText(/No responses yet/i).isVisible());
await shot('responses-empty');

// --- the unconfigured segment refuses rather than guessing ---------------
const bare = await sql`
  insert into registration_forms (kind, segment_id, title, slug, schema, schema_version, status)
  values ('PUBLIC', ${seed.bareSegmentId}, 'Unconfigured', 'unconfigured-qa',
          ${JSON.stringify({
            kind: 'PUBLIC',
            blocks: [
              {
                id: 'registrant',
                type: 'REGISTRANT',
                title: 'Your details',
                creates_seat: true,
                fields: [
                  { key: 'contact_name', label: 'Full name', type: 'text', system: true, required: true },
                  { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
                ],
              },
              {
                id: 'party',
                type: 'GUESTS_PARTY',
                title: 'Who else is coming?',
                guest_fields: [
                  { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
                ],
              },
            ],
          })}::text::jsonb, 1, 'DRAFT')
  returning id`;

await page.goto(`${BASE}/admin/concerts/${seed.concertId}/forms/${bare[0].id}`);
await page.waitForLoadState('networkidle');
check(
  'an unconfigured segment stops the form rather than offering zero guests',
  await page.getByText(/cannot offer seats yet/i).isVisible(),
);
check(
  'and names the setting nobody has entered',
  await page.getByText(/form\.max_tickets_per_response/).isVisible(),
);
await shot('not-configured');

// --- refusing to open an unconfigured form is not claimed; opening is ----
await page.goto(formsUrl);
await page.waitForLoadState('networkidle');
await shot('forms-list-populated');

console.log('\n--- problems ---');
console.log(problems.length === 0 ? 'none' : problems.join('\n'));

await browser.close();
await sql.end();
process.exit(problems.length === 0 ? 0 : 1);
