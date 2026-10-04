import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { OUT, SHOTS, newPage, openAppearance, shot, sql, themeProbe } from './w-helpers';

/**
 * Module W — console themes (spec/v3.md §29.5), in Chromium. Theme state is
 * read from the live DOM; nothing here trusts the stored value alone.
 */
mkdirSync(SHOTS, { recursive: true });
// The shared connection (w-helpers) is closed when the worker exits.
const EVIDENCE = `${OUT}/theme-evidence.json`;
function record(key: string, value: unknown) {
  const cur = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : {};
  cur[key] = value;
  writeFileSync(EVIDENCE, JSON.stringify(cur, null, 2));
}

const THEMES = ['Default', 'Amber', 'Amethyst', 'Caffeine', 'Emerald', 'Graphite', 'Mono', 'Terracotta'];

/** sRGB of a CSS colour via canvas, then hue, and WCAG contrast against another. */
async function colourFacts(page: Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const rgb = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const hue = ([r, g, b]: number[]) => {
      const R = r! / 255, G = g! / 255, B = b! / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
      if (d === 0) return { h: null, s: 0 };
      let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      const l = (max + min) / 2;
      return { h: Math.round(h), s: +(d / (1 - Math.abs(2 * l - 1))).toFixed(2) };
    };
    const destructive = rgb(cs.getPropertyValue('--destructive').trim());
    const background = rgb(cs.getPropertyValue('--background').trim());
    const card = rgb(cs.getPropertyValue('--card').trim());
    const contrast = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return +((x! + 0.05) / (y! + 0.05)).toFixed(2);
    };
    return {
      destructive,
      background,
      hue: hue(destructive),
      contrastOnBackground: contrast(destructive, background),
      contrastOnCard: contrast(destructive, card),
    };
  });
}

test('FLOW-8 theme switch, every theme in both modes, persistence, fonts, scope', async ({ browser }) => {
  test.setTimeout(300_000);
  const settingsBefore = await sql`select md5(string_agg(key || value::text, ',' order by key)) h from system_settings`;
  const usersBefore = await sql`select count(*)::int h from audit_log`;
  const { ctx, page } = await newPage(browser, 'admin', { colorScheme: 'light' });
  await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
  const baseline = await themeProbe(page);

  // step 1: the menu
  await openAppearance(page);
  const themeItems = (await page.getByRole('menuitemradio').allInnerTexts()).map((t) => t.trim());
  record('menu', themeItems);
  expect(themeItems).toEqual(['Light', 'Dark', 'System', ...THEMES]);
  await shot(page, 'FLOW-8-step-1-menu', false);

  // step 2: pick Amethyst + Dark through the menu itself
  await page.getByRole('menuitemradio', { name: 'Amethyst' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect.poll(async () => (await themeProbe(page)).theme).toBe('amethyst');
  const picked = await themeProbe(page);
  expect(picked.dark).toBe(true);
  expect(picked.primary).not.toBe(baseline.primary);
  await shot(page, 'FLOW-8-step-2-amethyst-dark', false);
  await page.keyboard.press('Escape');

  // step 3: reload keeps it, and it is on <html> before first paint
  await page.addInitScript(() => {
    (window as unknown as { __themeAt: number | null }).__themeAt = null;
    new MutationObserver(() => {
      const w = window as unknown as { __themeAt: number | null };
      if (w.__themeAt === null && document.documentElement.getAttribute('data-theme')) w.__themeAt = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-theme'] });
  });
  await page.reload({ waitUntil: 'networkidle' });
  const after = await themeProbe(page);
  const timing = await page.evaluate(() => ({
    themeAt: (window as unknown as { __themeAt: number | null }).__themeAt,
    firstPaint: performance.getEntriesByType('paint').find((e) => e.name === 'first-paint')?.startTime ?? null,
    fcp: performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? null,
  }));
  record('reload', { after, timing });
  expect(after.theme).toBe('amethyst');
  expect(after.dark).toBe(true);
  expect(timing.themeAt).not.toBeNull();
  if (timing.firstPaint !== null) expect(timing.themeAt!).toBeLessThanOrEqual(timing.firstPaint);
  await shot(page, 'FLOW-8-step-3-after-reload', false);

  // step 4: a second browser is unaffected, and nothing was stored server-side
  const other = await newPage(browser, 'admin', { colorScheme: 'light' });
  await other.page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
  const otherProbe = await themeProbe(other.page);
  record('otherBrowser', otherProbe);
  expect(otherProbe.theme).toBeNull();
  expect(otherProbe.dark).toBe(false);
  await shot(other.page, 'FLOW-8-step-4-other-browser-default', false);
  await other.ctx.close();
  expect((await sql`select md5(string_agg(key || value::text, ',' order by key)) h from system_settings`)[0].h).toBe(settingsBefore[0].h);
  expect((await sql`select count(*)::int h from audit_log`)[0].h).toBe(usersBefore[0].h);

  // step 5: every theme x mode — applied, destructive reads red, fonts loaded
  const sweep: Record<string, unknown> = {};
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark']) {
      await page.evaluate(([t, m]) => {
        localStorage.setItem('zetix.console.theme', t!);
        localStorage.setItem('zetix.console.mode', m!);
      }, [theme.toLowerCase(), mode]);
      await page.reload({ waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const probe = await themeProbe(page);
      const colours = await colourFacts(page);
      const fonts = await page.evaluate(() => {
        const first = getComputedStyle(document.body).fontFamily.split(',')[0]!.trim();
        return {
          first,
          checked: document.fonts.check(`16px ${first}`),
          loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
        };
      });
      sweep[`${theme}/${mode}`] = { probe, colours, fonts };
      if (theme === 'Default') expect(probe.theme).toBeNull();
      else expect(probe.theme).toBe(theme.toLowerCase());
      expect(probe.dark).toBe(mode === 'dark');
      if (['Amber', 'Graphite', 'Emerald'].includes(theme)) await shot(page, `FLOW-8-step-5-${theme.toLowerCase()}-${mode}`, false);
    }
  }
  record('sweep', sweep);

  // step 6: corrupt storage falls back to Default
  await page.evaluate(() => {
    localStorage.setItem('zetix.console.theme', '"><img src=x onerror=alert(1)>');
    localStorage.setItem('zetix.console.mode', 'purple');
  });
  let dialogs = 0;
  page.on('dialog', async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await page.reload({ waitUntil: 'networkidle' });
  const corrupt = await themeProbe(page);
  record('corrupt', corrupt);
  expect(corrupt.theme).toBeNull();
  expect(dialogs).toBe(0);
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await shot(page, 'FLOW-8-step-6-corrupt-storage-default', false);
  await ctx.close();

  // Assertions over the sweep, after the evidence is written.
  for (const [key, v] of Object.entries(sweep) as [string, { colours: { hue: { h: number | null; s: number }; contrastOnBackground: number }; fonts: { checked: boolean } }][]) {
    const h = v.colours.hue.h;
    expect.soft(h !== null && (h <= 30 || h >= 340), `${key} --destructive hue ${h} reads as red`).toBe(true);
    expect.soft(v.colours.contrastOnBackground, `${key} --destructive contrast on --background`).toBeGreaterThanOrEqual(3);
    expect.soft(v.fonts.checked, `${key} body font loaded`).toBe(true);
  }
});

test('FLOW-8b the console theme does not reach the public surfaces', async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page } = await newPage(browser, 'admin', { colorScheme: 'light' });
  await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('zetix.console.theme', 'supabase');
    localStorage.setItem('zetix.console.mode', 'dark');
  });
  await page.reload({ waitUntil: 'networkidle' });
  const admin = await themeProbe(page);
  expect(admin.theme).toBe('supabase');

  const [{ qr_token: token }] = await sql`select qr_token from attendees where qr_token is not null and deleted_at is null limit 1`;
  const results: Record<string, unknown> = { admin };
  const anon = await newPage(browser, 'anon', { colorScheme: 'light' });
  await anon.page.goto('/f/qa-autumn', { waitUntil: 'networkidle' });
  const publicBaseline = await themeProbe(anon.page);
  results.publicBaselineFreshBrowser = publicBaseline;
  await anon.ctx.close();

  let n = 1;
  for (const path of ['/f/qa-autumn', `/t/${token}`, '/scan/login']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const p = await themeProbe(page);
    results[`hard ${path.startsWith('/t/') ? '/t/{token}' : path}`] = p;
    expect(p.theme, path).toBeNull();
    if (!path.startsWith('/scan')) {
      expect(p.dark, path).toBe(false);
      expect(p.primary, path).toBe(publicBaseline.primary);
      expect(p.bodyFont, path).toBe(publicBaseline.bodyFont);
    }
    await shot(page, `FLOW-8b-step-${n++}-hard-${path.split('/')[1]}`, false);
  }

  // client-side navigation out of the console
  await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
  expect((await themeProbe(page)).theme).toBe('supabase');
  await page.evaluate(() => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push('/f/qa-autumn'));
  await page.waitForURL(/\/f\/qa-autumn/);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const soft = await themeProbe(page);
  const softCard = await page.evaluate(() => {
    const el = document.querySelector('main [data-slot="card"], main .rounded-lg, main form') as HTMLElement | null;
    return el ? { radius: getComputedStyle(el).borderRadius, font: getComputedStyle(el).fontFamily } : null;
  });
  results['soft /f/qa-autumn'] = { soft, softCard };
  expect(soft.theme).toBeNull();
  expect(soft.dark).toBe(false);
  expect(soft.primary).toBe(publicBaseline.primary);
  expect.soft(soft.bodyFont, 'font after client navigation').toBe(publicBaseline.bodyFont);
  await shot(page, `FLOW-8b-step-${n++}-soft-nav-form`, false);
  record('publicSurfaces', results);
  await ctx.close();
});

test('FLOW-8c the admin preview of a theme-less form does not take the console theme', async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page } = await newPage(browser, 'admin', { colorScheme: 'light' });
  const probeForm = async () => {
    const title = page.getByRole('heading', { name: 'Autumn Evening — public registration', level: 1 }).or(page.locator('main').getByText('Autumn Evening — public registration').nth(1)).first();
    const card = page.locator('main').getByText('Full name', { exact: false }).first().locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
    const eye = await page.locator('main a[href*="/f/"], main a[href*="preview"]').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href + ' target=' + (e as HTMLAnchorElement).target));
    const c = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderRadius, font: cs.fontFamily, background: cs.backgroundColor, text: cs.color, shadow: cs.boxShadow };
    }).catch((e) => ({ error: String(e) }));
    const t = await title.evaluate((el) => getComputedStyle(el).fontFamily).catch(() => null);
    return { card: c, titleFont: t, previewLinks: eye };
  };
  const out: Record<string, unknown> = {};
  for (const theme of ['default', 'supabase', 'graphite']) {
    await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
    await page.evaluate((t) => {
      localStorage.setItem('zetix.console.theme', t);
      localStorage.setItem('zetix.console.mode', 'light');
    }, theme);
    await page.goto('/admin/concerts/3/forms/1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    out[`builder ${theme}`] = await probeForm();
    await shot(page, `FLOW-8c-step-${theme === 'default' ? 1 : theme === 'supabase' ? 2 : 3}-builder-${theme}`, false);
  }
  // The builder's own Preview link (/preview/{id}, opened in a new tab), with the console on Graphite.
  await page.goto('/preview/1', { waitUntil: 'networkidle' });
  out.previewRoute = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), font: getComputedStyle(document.body).fontFamily }));
  await shot(page, 'FLOW-8c-step-5-preview-route-graphite', false);
  const anon = await newPage(browser, 'anon', { colorScheme: 'light' });
  await anon.page.goto('/f/qa-autumn', { waitUntil: 'networkidle' });
  out.public = await anon.page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { formAccent: root.getPropertyValue('--form-accent').trim(), formCard: root.getPropertyValue('--form-card').trim(), font: getComputedStyle(document.body).fontFamily };
  });
  await anon.page.screenshot({ path: `${SHOTS}/FLOW-8c-step-4-public-form.png`, fullPage: false });
  await anon.ctx.close();
  record('formPreview', out);
  await ctx.close();
  const d = (out['builder default'] as { card: Record<string, string> }).card;
  for (const t of ['supabase', 'graphite']) {
    const b = (out[`builder ${t}`] as { card: Record<string, string> }).card;
    expect.soft(b?.background, `${t} card background`).toBe(d?.background);
    expect.soft(b?.radius, `${t} card radius`).toBe(d?.radius);
    expect.soft(b?.font, `${t} card font`).toBe(d?.font);
  }
});

test('FLOW-9 a viewer can change the theme; FLOW-9b system mode follows the OS', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'viewer', { colorScheme: 'light' });
  await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
  await openAppearance(page);
  await page.getByRole('menuitemradio', { name: 'Mono' }).click();
  await expect.poll(async () => (await themeProbe(page)).theme).toBe('vercel');
  await shot(page, 'FLOW-9-step-1-viewer-vercel', false);
  await page.keyboard.press('Escape');
  await ctx.close();

  const dark = await newPage(browser, 'admin', { colorScheme: 'dark' });
  await dark.page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
  const sys = await themeProbe(dark.page);
  await shot(dark.page, 'FLOW-9-step-2-system-dark', false);
  await dark.page.emulateMedia({ colorScheme: 'light' });
  await dark.page.waitForTimeout(300);
  const sysLight = await themeProbe(dark.page);
  await shot(dark.page, 'FLOW-9-step-3-system-flipped-light', false);
  record('system', { sys, sysLight });
  expect(sys.dark).toBe(true);
  expect(sysLight.dark).toBe(false);
  await dark.ctx.close();
});
