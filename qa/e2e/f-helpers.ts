import type { Browser, BrowserContext, Page } from '@playwright/test';
import postgres from 'postgres';

export const QA_URL =
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';

export const newSql = () => postgres(QA_URL, { prepare: false, max: 2 });

export const SHOTS = 'qa-artifacts/F-outbox-blast/screens';

/** The ids `qa/support/start-f.sh` seeds. */
export const IDS = {
  concertId: '1',
  showId: '1',
  segmentPublic: '1',
  segmentPlayer: '2',
};

export const EMAIL_URL = (segment = IDS.segmentPublic, template = 'public_ticket') =>
  `/admin/concerts/${IDS.concertId}/email?segment=${segment}&template=${template}`;

export async function asAdmin(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** What the local SMTP sink has received since the last reset. */
export type SinkMessage = {
  rcptTo: string[];
  subject: string;
  attachments: number;
  filenames: string[];
};

export async function sink(): Promise<{ count: number; messages: SinkMessage[] }> {
  const res = await fetch('http://127.0.0.1:2527/');
  return res.json() as Promise<{ count: number; messages: SinkMessage[] }>;
}

export async function resetSink(): Promise<void> {
  await fetch('http://127.0.0.1:2527/reset');
}

/**
 * Empties the outbox and clears every delivery stamp, without touching
 * `concerts`/`shows`/`show_segments` — truncating those under a running
 * `next dev` makes every `/admin/concerts/{id}/*` page 404 for the rest of the
 * process (module `B`'s harness lesson).
 */
export async function resetBlast(sql: ReturnType<typeof newSql>): Promise<void> {
  await sql`delete from email_outbox`;
  // FLOW-7 adds a round-2 party; drop it so a re-run starts from the seed.
  await sql`delete from attendees a using registrations r
             where r.id = a.registration_id and r.contact_email = 'grace@example.test'`;
  await sql`delete from registrations where contact_email = 'grace@example.test'`;
  await sql`update attendees set ticket_sent_at = null, ticket_sent_source = null`;
}
