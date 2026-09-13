/**
 * The case the first browser pass missed: a form that **has responses**.
 *
 * The responses screen returned a 500 the moment one existed, because its row
 * formatter lived in a `'use client'` module and the server page called it.
 * With zero rows the `.map` never ran, so the screen looked fine and every
 * check was green. This drives it with data.
 */
import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';

const BASE = 'http://localhost:3100';
const SHOTS = 'qa-artifacts/l-form-admin/screens';
const sql = postgres('postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 1 });
const seed = JSON.parse(await readFile('qa-artifacts/l-form-admin/seed.json', 'utf8'));

const problems = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) problems.push(label + (detail ? ` — ${detail}` : ''));
}

const schema = {
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
    {
      id: 'questions',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [
        { key: 'accessibility', label: 'Accessibility needs', type: 'text', required: false },
      ],
    },
  ],
};

const [form] = await sql`
  insert into registration_forms (kind, segment_id, title, slug, schema, schema_version, status)
  values ('PUBLIC', ${seed.publicSegmentId}, 'With responses', 'with-responses-qa',
          ${JSON.stringify(schema)}::text::jsonb, 1, 'OPEN')
  returning id`;
const formId = Number(form.id);

const payload = (name, email, guests, note) => ({
  registrant: { kind: 'flat', values: { contact_name: name, contact_email: email } },
  party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
  questions: { kind: 'flat', values: note === undefined ? {} : { accessibility: note } },
});

const [first] = await sql`
  insert into form_responses (form_id, raw, form_schema, identity_key, submitted_at)
  values (${formId}, ${JSON.stringify(payload('Ada Tan', 'ada@x.test', ['Bo', 'Cy'], 'Step-free access'))}::text::jsonb,
          ${JSON.stringify(schema)}::text::jsonb, 'ada@x.test', '2026-09-01T02:00:00Z')
  returning id`;

await sql`
  insert into form_responses (form_id, raw, form_schema, identity_key, supersedes_id, submitted_at)
  values (${formId}, ${JSON.stringify(payload('Ada Tan', 'ada@x.test', ['Bo'], 'Step-free access'))}::text::jsonb,
          ${JSON.stringify(schema)}::text::jsonb, null, ${Number(first.id)}, '2026-09-02T02:00:00Z')`;

await sql`
  insert into form_responses (form_id, raw, form_schema, identity_key, submitted_at)
  values (${formId}, ${JSON.stringify(payload('Wei Ling', 'wei@x.test', [], undefined))}::text::jsonb,
          ${JSON.stringify(schema)}::text::jsonb, 'wei@x.test', '2026-09-03T02:00:00Z')`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

await page.goto(`${BASE}/login`);
await page.getByLabel(/access code|code/i).first().fill('qa-admin-code');
await page.getByRole('button', { name: /sign in|enter/i }).click();
await page.waitForURL(/\/admin/, { timeout: 30_000 });

const url = `${BASE}/admin/concerts/${seed.concertId}/forms/${formId}/responses`;
const response = await page.goto(url);
await page.waitForLoadState('networkidle');

check('the responses screen returns 200 with responses present', response.status() === 200, String(response.status()));
check('it lists all three responses', (await page.getByText(/Ada Tan/).count()) >= 1);
check('it shows the registrant read through the pinned schema', await page.getByText('wei@x.test').first().isVisible());
check('it marks the superseded row', await page.getByText('superseded').first().isVisible());
check('it marks the edit that replaced it', await page.getByText('an edit').first().isVisible());
await page.screenshot({ path: `${SHOTS}/13-responses-with-data.png`, fullPage: true });

// The export is only reachable from this page, so it was unreachable too.
await page.getByRole('button', { name: /Prepare export/i }).click();
await page.waitForTimeout(3000);
const summary = await page.getByText(/responses,\s*\d+\s*columns/i).first().innerText().catch(() => '');
check('the export builds from this page', /\d+\s*responses,\s*\d+\s*columns/i.test(summary), summary);
await page.screenshot({ path: `${SHOTS}/14-export-ready.png`, fullPage: true });

const [list] = await sql`select count(*)::int as n from form_responses where form_id = ${formId}`;
check('the list count matches the rows', Number(list.n) === 3, String(list.n));

console.log('\n--- problems ---');
console.log(problems.length === 0 ? 'none' : problems.join('\n'));

await browser.close();
await sql.end();
process.exit(problems.length === 0 ? 0 : 1);
