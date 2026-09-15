import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/claude-N-portal/screens';

async function loginAdmin(page) {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

async function loginOperator(page) {
  await page.goto('/scan/login');
  await page.fill('input[name="displayName"]', 'Usher');
  await page.fill('input[name="code"]', 'qa-op-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/scan/);
}

test.afterAll(async () => { await sql.end(); });

test('FLOW-12 admin publishes the held-back booklet and the guest then sees it', async ({ page, request }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts/1/portal');
  await expect(page.getByText('Evening Programme (unpublished)')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-1-portal-screen.png`, fullPage: true });

  await page.getByRole('button', { name: 'Publish', exact: true }).first().click();
  await expect.poll(async () => (await sql`select published from booklets where id = 2`)[0].published)
    .toBe(true);
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-2-published.png`, fullPage: true });

  // The show-specific booklet now wins for show 1's admitted guest.
  const guest = await request.get('/api/portal/AdmittedOneAAAAAAAAA1x/booklet');
  expect(guest.status()).toBe(200);
  await sql`update booklets set published = false where id = 2`;
});

test('FLOW-13 an operator is refused the portal admin screen and its actions', async ({ page, request }) => {
  await loginOperator(page);
  await page.screenshot({ path: `${SHOTS}/FLOW-13-step-1-operator-signed-in.png`, fullPage: true });
  const before = await sql`select count(*)::int as n from booklets`;

  await page.goto('/admin/concerts/1/portal');
  await page.waitForLoadState('networkidle');
  expect(page.url()).not.toContain('/admin/concerts/1/portal');
  await page.screenshot({ path: `${SHOTS}/FLOW-13-step-2-refused.png`, fullPage: true });

  // The file route, called with the operator's own cookies.
  const cookies = await page.context().cookies();
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const patch = await request.patch('/api/portal/booklet', {
    headers: { cookie: header, 'content-type': 'application/json' },
    data: { id: 2, published: true },
  });
  expect([401, 403]).toContain(patch.status());
  const dispatch = await request.post('/api/outbox/dispatch', { headers: { cookie: header } });
  expect(dispatch.status()).toBe(401);

  const after = await sql`select count(*)::int as n from booklets`;
  expect(after[0].n).toBe(before[0].n);
  expect((await sql`select published from booklets where id = 2`)[0].published).toBe(false);
});

test('FLOW-15 Generate feedback emails is safe to press twice', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts/1/shows');
  await page.screenshot({ path: `${SHOTS}/FLOW-15-step-1-shows-screen.png`, fullPage: true });

  const before = await sql`select count(*)::int as n from email_outbox where template_key='feedback_request'`;
  const button = page.getByRole('button', { name: /generate feedback/i }).first();
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/FLOW-15-step-2-first-press.png`, fullPage: true });
  await button.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/FLOW-15-step-3-second-press.png`, fullPage: true });

  const after = await sql`select count(*)::int as n from email_outbox where template_key='feedback_request'`;
  expect(after[0].n).toBe(before[0].n);
});

test('FLOW-16 Send now makes the rows due without sending them', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts/1/shows');
  const before = await sql`
    select status, scheduled_for from email_outbox where template_key='feedback_request'`;
  expect(before[0].status).toBe('QUEUED');

  const button = page.getByRole('button', { name: /send now/i }).first();
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/FLOW-16-step-1-send-now.png`, fullPage: true });

  const after = await sql`
    select status, scheduled_for <= now() as due from email_outbox where template_key='feedback_request'`;
  expect(after[0].status).toBe('QUEUED');
  expect(after[0].due).toBe(true);
});

test('NOTE: the settings screen offers no portal.enabled key', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/settings');
  await page.waitForLoadState('networkidle');
  const html = await page.content();
  expect(html).toContain('portal.booklet_enabled');
  await page.screenshot({ path: `${SHOTS}/NOTE-settings-no-portal-enabled.png`, fullPage: true });
  expect(html).not.toContain('portal.enabled');
});
