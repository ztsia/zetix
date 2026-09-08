import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * A PDF background reaches the editor canvas (spec/tickets.md §10.3).
 *
 * **The regression this exists for was invisible from the outside.** The upload
 * succeeded, the page box was read correctly, the worker fetched 200, and the
 * canvas stayed white — because pdf.js's default build calls
 * `Map.prototype.getOrInsertComputed`, which this Chromium does not have, and a
 * bare `catch {}` swallowed the throw. An admin laid a ticket out over a blank
 * page while the card said the artwork had loaded.
 *
 * Two things are asserted, and both matter: the artwork is actually **drawn**
 * (the fixture is a near-black page, so a working canvas is mostly dark), and
 * nothing is reported as having failed. A future pdf.js bump that reintroduces
 * the incompatibility turns this red rather than silently blanking the canvas.
 */

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 1,
});

/** A5 portrait, 420 x 595 pt, painted almost entirely black. */
const A5_PDF = readFileSync('/tmp/qa2-a5.pdf');

async function loginAdmin(page: import('@playwright/test').Page) {
  await page.goto('http://localhost:3100/login');
  await page.getByLabel(/code/i).fill('qa-admin-code');
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await page.waitForURL(/\/admin/);
}

/** How much of the canvas is dark — i.e. how much of the artwork was drawn. */
async function darkFraction(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return -1;
    const context = canvas.getContext('2d');
    if (!context) return -1;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark += 1;
    }
    return dark / (data.length / 4);
  });
}

for (const mimeType of ['application/pdf', 'application/octet-stream']) {
  test(`a PDF background draws on the canvas, offered as ${mimeType}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`));

    await loginAdmin(page);

    // The list page is what seeds a concert's three defaults (decision 10), so
    // querying before visiting it finds nothing on a freshly seeded database.
    await page.goto('http://localhost:3100/admin/concerts/1/tickets/templates');
    await expect(page.getByText('Classic Landscape')).toBeVisible();

    const [template] = await sql<{ id: number }[]>`
      select id from ticket_templates where name = 'Classic Landscape'
       order by version desc limit 1
    `;
    await page.goto(`http://localhost:3100/admin/concerts/1/tickets/templates/${template.id}`);
    await expect(page.locator('canvas').first()).toBeVisible();

    await page.locator('input[type=file]').first().setInputFiles({
      // `application/octet-stream` is what a file manager that does not know the
      // extension sends. §10.3 types artwork by its leading bytes, so both must
      // measure and draw identically.
      name: 'artwork.pdf',
      mimeType,
      buffer: A5_PDF,
    });
    await expect(page.getByText('PDF artwork loaded.')).toBeVisible({ timeout: 20_000 });

    // The page box, in points, is authoritative for a PDF (§10.3).
    await expect(page.locator('#page-w')).toHaveValue('420');
    await expect(page.locator('#page-h')).toHaveValue('595');

    // Nothing may report a failure, and the artwork must actually be there.
    await expect(page.getByText(/could not be drawn/i)).toHaveCount(0);
    await expect.poll(() => darkFraction(page), { timeout: 15_000 }).toBeGreaterThan(0.5);

    expect(consoleErrors).toEqual([]);
  });
}
