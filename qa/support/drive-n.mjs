import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const seed = JSON.parse(readFileSync('qa-artifacts/n-portal/seed.json', 'utf8'));
const BASE = 'http://localhost:3100';
const OUT = 'qa-artifacts/n-portal/screens';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
// A phone, because this surface is mobile-first and read in a dark hall.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  shot ${name}`);
}

console.log('— post-show portal, admitted —');
await page.goto(`${BASE}/t/${seed.tokens.admittedOne}`, { waitUntil: 'networkidle' });
await shot('01-post-show');

console.log('— filling the feedback form —');
await page.getByLabel('Overall', { exact: false }).selectOption('wonderful');
await page.getByLabel('What stayed with you?', { exact: false }).fill('The slow movement, and the encore.');
await page.getByRole('checkbox', { name: /I would come again/i }).check();
await shot('02-feedback-filled');

await page.getByRole('button', { name: /send feedback/i }).click();
await page.waitForTimeout(2500);
await shot('03-thank-you');
console.log('  after submit:', (await page.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | '));

console.log('— reopening the same link —');
await page.goto(`${BASE}/t/${seed.tokens.admittedOne}`, { waitUntil: 'networkidle' });
const reopened = await page.locator('body').innerText();
console.log('  thank-you persists:', /thank you/i.test(reopened));
await shot('04-reopened');

console.log('— change my answer —');
const change = page.getByRole('button', { name: /change my answer/i });
if (await change.count()) {
  await change.click();
  await page.waitForTimeout(500);
  const val = await page.getByLabel('What stayed with you?', { exact: false }).inputValue();
  console.log('  prefilled with:', JSON.stringify(val));
  await shot('05-change-answer');
} else {
  console.log('  !! no change-my-answer control');
}

console.log('— a validation failure —');
await page.getByLabel('What stayed with you?', { exact: false }).fill('');
await page.getByRole('button', { name: /send feedback/i }).click();
await page.waitForTimeout(1500);
const afterEmpty = await page.locator('body').innerText();
console.log('  refused with a message:', /required|cannot be empty|answer/i.test(afterEmpty));
await shot('06-validation');

console.log('— pre-show portal —');
await page.goto(`${BASE}/t/${seed.tokens.upcoming}`, { waitUntil: 'networkidle' });
await shot('07-pre-show');

console.log('— cancelled —');
await page.goto(`${BASE}/t/${seed.tokens.cancelled}`, { waitUntil: 'networkidle' });
await shot('08-cancelled');

console.log('— unknown token —');
await page.goto(`${BASE}/t/ZzZzZzZzZzZzZzZzZzZzZz`, { waitUntil: 'networkidle' });
await shot('09-not-found');

console.log('\nconsole errors:', errors.length ? errors : 'none');
await browser.close();
