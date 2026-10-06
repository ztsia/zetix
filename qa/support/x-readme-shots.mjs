// usage: node qa/support/x-readme-shots.mjs <outdir>   — the README's screenshots, from `pnpm demo`
//
// Run against `pnpm demo` with `src/lib/brand.ts` reading 'Zetix' (uncommitted), so the console
// shows the mark exactly as the public copy does. Every id is looked up, never assumed.
import { chromium, devices } from '@playwright/test';
import postgres from 'postgres';

const [out] = process.argv.slice(2);
if (!out) throw new Error('usage: node qa/support/x-readme-shots.mjs <outdir>');
const BASE = 'http://localhost:3100';
const sql = postgres(process.env.DEMO_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_demo', { max: 1 });

const [concert] = await sql`select id from concerts order by id limit 1`;
const [rehearsal, gala] = await sql`select id from shows order by starts_at`;
/** A gala party of three, every name given, tickets sent: the record that shows most. */
const [party] = await sql`
  select a.registration_id as id
    from attendees a
   where a.show_id = ${gala.id} and a.deleted_at is null
   group by a.registration_id
  having count(*) = 3 and bool_and(a.ticket_sent_at is not null) and bool_and(a.name_source <> 'PLACEHOLDER')
   order by a.registration_id limit 1`;
const [galaSeat] = await sql`
  select qr_token from attendees where registration_id = ${party.id} and qr_token is not null order by id limit 1`;
const [pastSeat] = await sql`
  select a.qr_token from attendees a
    join check_ins c on c.attendee_id = a.id
   where a.show_id = ${rehearsal.id} and a.qr_token is not null order by a.id limit 1`.catch(async () =>
  sql`select qr_token from attendees where show_id = ${rehearsal.id} and qr_token is not null order by id limit 1`);
await sql.end();

const c = `/admin/concerts/${concert.id}`;
const browser = await chromium.launch();
const problems = [];

// Next's dev-mode indicator is not part of the app.
const HIDE_DEV = () => {
  const style = document.createElement('style');
  style.textContent = 'nextjs-portal { display: none !important; }';
  document.addEventListener('DOMContentLoaded', () => document.head.append(style));
};

async function shoot(page, name, path, { full = false, settle = 600 } = {}) {
  if (path) await page.goto(path, { waitUntil: 'networkidle', timeout: 120000 });
  // The failed-message banner is real, and Home's "Send failed" card already shows it;
  // hidden here so it does not top every screenshot.
  const hide = page.getByRole('button', { name: 'Hide this banner' });
  if (await hide.count()) await hide.first().click();
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  console.log(name, page.url());
}

function watch(page) {
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`[${r.status()}] ${r.url()}`); });
}

// The console, signed in as the demo admin. Theme and mode go in before any script runs.
async function consolePage(theme, mode) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: mode });
  await ctx.addInitScript(([t, m]) => {
    localStorage.setItem('zetix.console.theme', t);
    localStorage.setItem('zetix.console.mode', m);
  }, [theme, mode]);
  await ctx.addInitScript(HIDE_DEV);
  const page = await ctx.newPage();
  watch(page);
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('admin@example.org');
  await page.locator('input[name="password"]').fill('demo-admin-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
  return page;
}

const light = await consolePage('default', 'light');
await shoot(light, 'home', `${c}/home`);
await shoot(light, 'audience', `${c}/audience`);
await shoot(light, 'party', `${c}/audience/${party.id}`);
await shoot(light, 'checkin', `${c}/checkin?show=${rehearsal.id}`);
await light.context().close();

const dark = await consolePage('claude', 'dark');
await shoot(dark, 'home-dark', `${c}/home`);
await shoot(dark, 'audience-dark', `${c}/audience`);
await dark.context().close();

// The door, on a phone, as usher Aisyah: a search at the gala, and the rehearsal's figures.
const phone = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE });
await phone.addInitScript(HIDE_DEV);
const door = await phone.newPage();
watch(door);
await door.goto('/scan/login');
await door.locator('input[name="displayName"]').fill('aisyah');
await door.locator('input[name="code"]').fill('demo-usher-code');
await Promise.all([door.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 60000 }), door.locator('button[type="submit"]').click()]);
const tab = (name) => door.getByRole('tab', { name }).or(door.getByRole('button', { name })).first();
await door.goto(`/scan/${gala.id}`, { waitUntil: 'networkidle' });
await door.waitForTimeout(1500);
await tab(/^Search/i).click();
await door.locator('input').first().fill(process.env.SEARCH ?? 'Ingleby');
await shoot(door, 'scanner-search', null, { settle: 1200 });
await door.goto(`/scan/${rehearsal.id}`, { waitUntil: 'networkidle' });
await door.waitForTimeout(1500);
await tab(/^Stats/i).click();
await shoot(door, 'scanner-stats', null, { settle: 1200 });
await phone.close();

// The ticket page, which is the portal: a gala seat ahead, a rehearsal seat behind.
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], baseURL: BASE, colorScheme: scheme });
  await ctx.addInitScript(HIDE_DEV);
  const page = await ctx.newPage();
  watch(page);
  await shoot(page, `ticket-${scheme}`, `/t/${galaSeat.qr_token}`, { settle: 1000 });
  if (scheme === 'light' && pastSeat) await shoot(page, 'portal-after', `/t/${pastSeat.qr_token}`, { settle: 1000 });
  await ctx.close();
}

await browser.close();
console.log(problems.join('\n') || 'no errors');
