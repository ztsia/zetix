import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

test('the sidebar nav is reachable at a normal laptop height', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await loginAdmin(page);
  const [{ id }] = await sql`select id from concerts where slug = 'qa-opener'`;
  await page.goto(`/admin/concerts/${id}/overview`);

  const report: Record<string, unknown> = {};
  for (const label of ['Overview', 'Portal', 'Notes', 'Exports', 'Settings']) {
    const link = page.getByRole('link', { name: label, exact: true }).first();
    const box = await link.boundingBox();
    const clickable = box
      ? await page.evaluate(
          ({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el?.closest('a')?.textContent?.trim() ?? el?.tagName ?? 'none';
          },
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        )
      : 'no box';
    report[label] = { y: box ? Math.round(box.y) : null, inViewport: box ? box.y + box.height <= 720 : false, topElementAtCentre: clickable };
  }
  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${SHOTS}/SIDEBAR-overflow-1280x720.png`, fullPage: false });

  // Regression test. Every §14.1 nav entry must be reachable without discovering
  // that the nav column scrolls. This was red when QA found it — the last group
  // was clipped and the pixels where Portal/Notes/Exports should be belonged to
  // the footer. The nav was tightened (a one-item group lost its redundant
  // heading, group padding and label height came down) so all fourteen screens
  // fit a 720px laptop.
  for (const label of ['Portal', 'Notes', 'Exports']) {
    expect.soft((report[label] as Record<string, unknown>).topElementAtCentre, label).toBe(label);
  }
  // ...and it does become reachable once the column is scrolled, so this is a
  // discoverability defect rather than a dead link.
  await page.evaluate(() => {
    const el = document.querySelector('[data-slot="sidebar-content"]') as HTMLElement;
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('link', { name: 'Exports', exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/SIDEBAR-scrolled-to-bottom.png` });
  await ctx.close();
});
