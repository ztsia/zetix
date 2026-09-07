import { test, expect, type Page } from '@playwright/test';

/**
 * The segment form dialog on an ordinary laptop viewport.
 *
 * The admin console is web-first (`surfaces.md` §15.1), so 1280×720 and
 * 1366×768 are its normal targets, not edge cases.
 */
test.setTimeout(120_000);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

async function openSegmentDialog(page: Page) {
  await page.goto('/admin/concerts/1/shows');
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Player invited' })
    .first()
    .getByRole('button', { name: 'Edit' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the submit button cannot be reached at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);
  const dialog = await openSegmentDialog(page);
  const save = dialog.getByRole('button', { name: 'Save segment' });

  const before = await save.boundingBox();
  const env = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    innerHeight: window.innerHeight,
  }));

  // Everything a person could try: the wheel, keyboard scrolling, and
  // Playwright's own scroll-into-view.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  const afterWheel = await save.boundingBox();

  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  const afterEnd = await save.boundingBox();

  let scrolledIntoView: string;
  try {
    await save.scrollIntoViewIfNeeded({ timeout: 4000 });
    scrolledIntoView = JSON.stringify(await save.boundingBox());
  } catch (error) {
    scrolledIntoView = `threw: ${(error as Error).message.split('\n')[0]}`;
  }

  console.log(
    'REACHABILITY',
    JSON.stringify({
      env,
      before,
      afterWheel,
      afterEnd,
      scrolledIntoView,
      belowTheFold: (before?.y ?? 0) + (before?.height ?? 0) > env.innerHeight,
    }),
  );

  await page.screenshot({
    path: 'qa-artifacts/A-config-and-people/screens/FLOW-4-step-1-dialog-overflows-viewport.png',
  });

  let clicked = 'no';
  try {
    await save.click({ timeout: 5000 });
    clicked = 'yes';
  } catch (error) {
    clicked = `failed: ${(error as Error).message.split('\n')[0]}`;
  }
  console.log('CLICK RESULT', clicked);

  // The finding, asserted: on a 720px-tall screen the button sits below the
  // fold and nothing scrolls it into view.
  expect(clicked).toBe('yes');
});

test('every module A dialog, measured at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);

  const measure = async (label: string, open: () => Promise<void>, submit: string) => {
    await page.goto('/admin/concerts/1/shows');
    await open();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    const button = dialog.getByRole('button', { name: submit });
    const box = (await button.count()) ? await button.boundingBox() : null;
    const g = await dialog.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
    console.log(
      'DIALOG',
      JSON.stringify({ label, geometry: g, submitBottom: box ? Math.round(box.y + box.height) : null, viewport: 720 }),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  };

  await measure(
    'segment (edit)',
    async () =>
      page
        .getByRole('listitem')
        .filter({ hasText: 'Player invited' })
        .first()
        .getByRole('button', { name: 'Edit' })
        .click(),
    'Save segment',
  );
  await measure(
    'show (new)',
    async () => page.getByRole('button', { name: 'New show' }).click(),
    'Create show',
  );
  await measure(
    'move capacity',
    async () => page.getByRole('button', { name: 'Move capacity' }).first().click(),
    'Save capacities',
  );

  await page.goto('/admin/concerts/1/players');
  await page.getByRole('button', { name: 'New player' }).click();
  const pd = page.getByRole('dialog').first();
  await expect(pd).toBeVisible();
  const pg = await pd.evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
  console.log('DIALOG', JSON.stringify({ label: 'player (new)', geometry: pg, viewport: 720 }));
});
