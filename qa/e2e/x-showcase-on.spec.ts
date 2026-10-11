import { test, expect, type Page } from '@playwright/test';

// Run against a dev server started WITH SHOWCASE=1 (spec/v3.md 31, 31.1). FLOW-2..9.
const S = 'qa-artifacts/claude-X-publication/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${S}/${name}.png` });
const door = (page: Page) => page.locator('#door');
const SCAN = 'Scan Eleanor’s ticket';

test('FLOW-2 desktop: landing at /, hero markup, enlarge dialog', async ({ page }) => {
  const res = await page.goto('/');
  expect(res!.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('From sign-up');
  expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
  await expect(page).toHaveTitle('Zetix · Ticketing for free concerts');
  await shot(page, 'FLOW-2-step-1-hero');

  const video = page.locator('video.zx-hero__video');
  expect(await video.count()).toBe(1);
  expect(
    await video.evaluate((v: HTMLVideoElement) => [v.muted, v.loop, v.playsInline, v.preload]),
  ).toEqual([true, true, true, 'none']);
  const srcs = await video
    .locator('source')
    .evaluateAll((els) => els.map((e) => (e as HTMLSourceElement).getAttribute('src')));
  expect(srcs).toEqual(['/showcase/zetix-hero-portrait.mp4', '/showcase/zetix-hero.mp4']);
  for (const f of [
    'zetix-hero.mp4',
    'zetix-hero-portrait.mp4',
    'zetix-hero-poster.jpg',
    'zetix-hero-portrait-poster.jpg',
    'zetix-thumbnail.jpg',
  ]) {
    const r = await page.request.get(`/showcase/${f}`);
    expect(r.status(), f).toBe(200);
  }

  await page.locator('#programme').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot(page, 'FLOW-2-step-2-programme');

  const enlarge = page.getByRole('button', { name: /^Enlarge:/ }).first();
  await enlarge.scrollIntoViewIfNeeded();
  await enlarge.click({ force: true });
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await shot(page, 'FLOW-2-step-3-enlarged');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await shot(page, 'FLOW-2-step-4-closed');
});

test('FLOW-3 door: admit, refuse repeat, offline admits then syncs, no navigation', async ({ page }) => {
  const reqs: string[] = [];
  await page.goto('/');
  await door(page).scrollIntoViewIfNeeded();
  page.on('request', (r) => reqs.push(r.method() + ' ' + r.url()));
  const nav: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) nav.push(f.url()); });

  await page.getByRole('button', { name: SCAN }).first().click();
  await expect(page.locator('.zx-scanner__verdict')).toHaveText('Admitted', { timeout: 8000 });
  await expect(page.locator('.zx-scanner__party')).toHaveText('Party of 3 · 1 in, 2 remaining');
  await shot(page, 'FLOW-3-step-1-admitted');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByRole('button', { name: 'Scan it again' }).first().click();
  await expect(page.locator('.zx-scanner__verdict')).toHaveText('Already checked in', { timeout: 8000 });
  await expect(page.locator('.zx-scanner__detail')).toContainText('First scanned');
  await shot(page, 'FLOW-3-step-2-duplicate');
  await expect(page.locator('.zx-scanner__pill')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('switch', { name: /Signal/ }).click();
  await expect(page.locator('.zx-scanner__pill')).toContainText('Offline');
  await page.getByRole('button', { name: new RegExp(SCAN) }).first().click();
  await expect(page.locator('.zx-scanner__verdict')).toHaveText('Admitted', { timeout: 8000 });
  await expect(page.locator('.zx-scanner__pill')).toContainText('Offline · 1 waiting');
  await shot(page, 'FLOW-3-step-3-offline-admitted');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('switch', { name: /Signal/ }).click();
  await expect(page.locator('.zx-scanner__pill').last()).toContainText('Syncing 1');
  await shot(page, 'FLOW-3-step-4-syncing');
  await expect(page.locator('.zx-scanner__pill')).toHaveCount(0, { timeout: 5000 });

  expect(reqs.filter((r) => /ORC-SDM1|\/t\//.test(r))).toEqual([]);
  expect(reqs.filter((r) => r.startsWith('POST'))).toEqual([]);
  expect(nav).toEqual([]);
});

test('FLOW-3b door under real network offline', async ({ page, context }) => {
  await page.goto('/');
  await door(page).scrollIntoViewIfNeeded();
  await context.setOffline(true);
  await page.getByRole('button', { name: SCAN }).first().click();
  await expect(page.locator('.zx-scanner__verdict')).toHaveText('Admitted', { timeout: 8000 });
  await context.setOffline(false);
});

test('FLOW-3c door timestamp does not move with the viewer timezone (concert timezone rule)', async ({ browser }) => {
  const seen: string[] = [];
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const ctx = await browser.newContext({ timezoneId: tz, locale: 'en-GB' });
    const page = await ctx.newPage();
    await page.goto('/');
    await door(page).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: SCAN }).first().click();
    await expect(page.locator('.zx-scanner__verdict')).toHaveText('Admitted', { timeout: 8000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Scan it again' }).first().click();
    await expect(page.locator('.zx-scanner__detail')).toContainText('First scanned', { timeout: 8000 });
    seen.push((await page.locator('.zx-scanner__detail').textContent()) ?? '');
    await ctx.close();
  }
  console.log('TZ-DETAIL', JSON.stringify(seen));
  expect(seen[0]).toBe(seen[1]);
});

test('FLOW-4 live phone: asleep, wake, empty submit refused, valid submit stays in the browser', async ({ page }) => {
  await page.goto('/');
  const phone = page.locator('.zx-encore__phone');
  await phone.scrollIntoViewIfNeeded();
  const frameEl = phone.locator('iframe');
  expect(await frameEl.evaluate((f: HTMLIFrameElement) => f.inert)).toBe(true);
  expect(await frameEl.getAttribute('src')).toBe('/showcase/phone/after');
  await shot(page, 'FLOW-4-step-1-asleep');
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') posts.push(r.method() + ' ' + r.url());
  });
  await phone.getByRole('button', { name: /^Try it/ }).click();
  expect(await frameEl.evaluate((f: HTMLIFrameElement) => f.inert)).toBe(false);
  const f = page.frameLocator('.zx-encore__phone iframe');
  await expect(f.getByText('How was your afternoon?')).toBeVisible();
  await shot(page, 'FLOW-4-step-2-awake');
  await f.getByRole('button', { name: 'Send feedback' }).click();
  await expect(f.getByText(/required|choose|rating|Please/i).first()).toBeVisible({ timeout: 5000 });
  await shot(page, 'FLOW-4-step-3-invalid');
  await expect(f.getByText('Thank you').first()).toHaveCount(0);
  await f.locator('[role=radio], input[type=radio]').first().click({ force: true });
  await f.getByRole('button', { name: 'Send feedback' }).click();
  await expect(f.getByText('Thank you').first()).toBeVisible({ timeout: 5000 });
  await shot(page, 'FLOW-4-step-4-thanks');
  expect(posts).toEqual([]);
});

test('FLOW-4b phone page directly: links do not navigate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/showcase/phone/ticket');
  await expect(page.getByText('Eleanor Whitfield').first()).toBeVisible();
  await shot(page, 'FLOW-4-step-5-ticket-page');
  const before = page.url();
  const link = page.locator('a[href*="google.com/maps"]').first();
  if (await link.count()) {
    await link.click();
    await page.waitForTimeout(500);
    console.log('LINK-HINT', await page.locator('body').innerText().then((t) => /real portal/.test(t)));
    expect(page.url()).toBe(before);
  }
});

test('FLOW-5 walkthrough loads the player only on click', async ({ page }) => {
  const reqs: string[] = [];
  page.on('request', (r) => reqs.push(r.url()));
  await page.route(/youtube/, (r) => r.abort());
  await page.goto('/');
  await page.waitForTimeout(1500);
  expect(reqs.filter((u) => /youtube|ytimg/.test(u))).toEqual([]);
  expect(await page.locator('iframe[src*="youtube"]').count()).toBe(0);
  await page.locator('#walkthrough').scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-5-step-1-cover');
  await page.getByRole('button', { name: /Play the walkthrough/ }).click();
  const player = page.locator('iframe[src*="youtube-nocookie.com/embed/tYE9JxSCns0"]');
  await expect(player).toHaveCount(1);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await shot(page, 'FLOW-5-step-2-player');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('FLOW-6 phone viewport: no horizontal overflow, nav usable', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(page, 'FLOW-6-step-1-top');
    const over = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    console.log('OVERFLOW', over);
    expect(over[0]).toBeLessThanOrEqual(over[1]);
    for (const id of ['#programme', '#notes', '#door', '#encore', '#walkthrough', '#curtain']) {
      await page.locator(id).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, id).toBeLessThanOrEqual(390);
    }
    await page.locator('#door').scrollIntoViewIfNeeded();
    await shot(page, 'FLOW-6-step-2-door');
    await page.locator('#notes').scrollIntoViewIfNeeded();
    await shot(page, 'FLOW-6-step-3-notes');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: 'Open the demo' }).first().tap();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(page.getByText('Sign in as a viewer')).toBeVisible();
    await shot(page, 'FLOW-6-step-4-demo-dialog');
  });
});

test.describe('reduced motion', () => {
  test('FLOW-7 reduced motion: loop not autoplayed, door still works', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const v = page.locator('video.zx-hero__video');
    await page.waitForTimeout(800);
    if (await v.count()) expect(await v.evaluate((e: HTMLVideoElement) => e.paused)).toBe(true);
    await shot(page, 'FLOW-7-step-1-hero');
    await door(page).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: SCAN }).first().click();
    await expect(page.locator('.zx-scanner__verdict')).toHaveText('Admitted', { timeout: 4000 });
    await shot(page, 'FLOW-7-step-2-door');
  });
});

test('FLOW-8 flag set: unknown phone screens are 404 in the browser', async ({ page }) => {
  for (const p of [
    '/showcase/phone/nope',
    '/showcase/phone/..%2F..%2Fetc',
    '/showcase/phone/ticket%00',
    '/showcase/phone/' + 'a'.repeat(5000),
  ]) {
    const r = await page.goto(p);
    expect(r!.status(), p.slice(0, 40)).toBe(404);
  }
  await page.goto('/showcase/phone/nope');
  await shot(page, 'FLOW-8-step-1-404');
});

test('FLOW-9 other surfaces unaffected, and load nothing of the showcase', async ({ page }) => {
  const scripts: string[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') scripts.push(r.url());
  });
  const r1 = await page.goto('/login');
  expect(r1!.status()).toBe(200);
  await expect(page.locator('input[type=password]')).toBeVisible();
  await shot(page, 'FLOW-9-step-1-login');
  const r2 = await page.goto('/scan/login');
  expect(r2!.status()).toBe(200);
  await shot(page, 'FLOW-9-step-2-scan-login');
  const r3 = await page.goto('/admin');
  console.log('ADMIN-URL', page.url(), r3!.status());
  expect(new URL(page.url()).pathname).toBe('/login');
  const bodies = await Promise.all(scripts.map(async (u) => (await page.request.get(u)).text().catch(() => '')));
  const hit = scripts.filter((u, i) => /lenis|motion-dom|framer/i.test(u) || /class Lenis/.test(bodies[i]));
  console.log('SCRIPT-HITS', hit);
  expect(hit).toEqual([]);
});
