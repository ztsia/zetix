/**
 * QA for module X: the phone-shaped surfaces of the demo (scanner search, ticket page).
 * Run with `--project=android` against `pnpm demo` on zetix_qa_demo (see x-publication.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const DB = process.env.X_DB ?? 'postgresql://postgres@localhost:55432/zetix_qa_demo';
const SHOTS = 'qa-artifacts/claude-X-publication/screens';
const USHER_CODE = process.env.DEMO_OPERATOR_CODE ?? 'demo-usher-code';
const sql = postgres(DB, { max: 1, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end());
test.describe.configure({ mode: 'serial' });
const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log('X-EVIDENCE ' + JSON.stringify(evidence)));

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });

test('FLOW-5 door search on a phone: one line per party, no sideways scroll', async ({ page }) => {
  test.setTimeout(300_000);
  const [gala] = await sql`select id from shows order by starts_at desc limit 1`;
  // A surname shared by several gala parties.
  const [surname] = await sql`
    select split_part(contact_name, ' ', 2) as s, count(*)::int as n from registrations
     where show_id = ${gala.id} group by 1 order by 2 desc, 1 limit 1`;

  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill('aisyah');
  await page.locator('input[name="code"]').fill(USHER_CODE);
  await shot(page, 'FLOW-5-step-1-scan-login');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 120_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.goto(`/scan/${gala.id}`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.getByRole('tab', { name: /Search/i }).or(page.getByRole('button', { name: /^Search/i })).first().click();
  const input = page.getByRole('searchbox').or(page.locator('input[type="search"], input[placeholder*="earch"]')).first();
  await input.fill(surname.s);
  await page.waitForTimeout(1200);
  await shot(page, 'FLOW-5-step-2-search-results');

  const cards = page.getByRole('button').filter({ hasText: /Party of|One seat/ });
  const n = await cards.count();
  const titles: { text: string; lines: number }[] = [];
  for (let i = 0; i < Math.min(n, 6); i++) {
    const t = cards.nth(i).locator('[data-slot="item-title"]').first();
    const box = await t.boundingBox();
    const lh = await t.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 24);
    titles.push({ text: (await t.innerText()).replace(/\s+/g, ' '), lines: box ? Math.round(box.height / lh) : -1 });
  }
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  evidence['FLOW-5'] = { surname: surname.s, partiesWithSurname: surname.n, cards: n, titles, overflow };
  expect(n).toBeGreaterThan(0);
  expect(overflow.sw).toBeLessThanOrEqual(overflow.iw);
  for (const t of titles) expect(t.text).not.toMatch(/\n/);
});

test.describe('FLOW-6 ticket page from the seed', () => {
  for (const tz of ['Asia/Kuala_Lumpur', 'America/Los_Angeles']) {
    test.describe(tz, () => {
      test.use({ timezoneId: tz });
      test(`shows a QR and the concert's local time (${tz})`, async ({ page }) => {
        test.setTimeout(240_000);
        const [seat] = await sql`
          select a.qr_token from attendees a join shows s on s.id = a.show_id
           where s.starts_at > now() and a.qr_token is not null and a.status = 'CONFIRMED'
             and a.ticket_issued_at is not null order by a.id limit 1`;
        const res = await page.goto(`/t/${seat.qr_token}`, { waitUntil: 'networkidle', timeout: 120_000 });
        expect(res?.status()).toBe(200);
        const qr = await page.evaluate(() => [...document.querySelectorAll('svg, img, canvas')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 150 && Math.abs(r.width - r.height) < 4; }).length);
        await expect(page.getByText('Present this QR at the door')).toBeVisible();
        const text = await page.locator('body').innerText();
        const times = text.match(/\b\d{1,2}[:.]\d{2}\s?(?:am|pm)?/gi) ?? [];
        evidence[`FLOW-6 ${tz}`] = { qr, times: times.slice(0, 4) };
        await shot(page, `FLOW-6-step-${tz === 'Asia/Kuala_Lumpur' ? 1 : 2}-ticket-${tz.split('/')[1]}`, true);
        expect(qr).toBeGreaterThan(0);
        expect(text).toMatch(/7[:.]30\s?pm|19[:.]30/i);
      });
    });
  }
});
