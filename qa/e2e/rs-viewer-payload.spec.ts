import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { signIn } from './rs-helpers';

/**
 * R x S seam, phase 4 — what reaches a VIEWER's browser from the Audience
 * workspace and the party record (spec/v3.md §28, §22).
 *
 * Greps the raw HTML **and** the RSC flight payload (`RSC: 1`) of every
 * Audience URL (both grains, every view, searches) and every party record, for
 * the contact details and credentials qa/support/seed-rs.mjs planted. The same
 * sweep as an ADMIN must find them — otherwise an empty page would pass.
 *
 * Seed: seed-s.mjs then seed-rs.mjs. Stack: qa/support/start-s.sh.
 */
const OUT = 'qa-artifacts/claude-S-audience-workspace-rs';
const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const C = '/admin/concerts/1';

const VIEWS = [
  'needs-review', 'unverified', 'needs-tickets', 'ready-to-send', 'sent', 'admitted', 'waitlisted',
  'cancelled', 'bounced', 'send-failed', 'suspicious-address', 'changed-after-send',
  'possible-duplicate', 'unnamed-guests', 'reply-waiting', 'over-capacity',
];

async function secrets() {
  const sql = postgres(DB, { max: 1 });
  const emails = (await sql`
    select contact_email::text as v from registrations where contact_email is not null
    union select email::text from attendees where email is not null
    union select to_email::text from email_outbox
    union select from_email::text from email_messages where from_email is not null
    union select email::text from players where email is not null
    union select email::text from app_users`).map((r) => r.v as string);
  const tokens = (await sql`
    select qr_token as v from attendees where qr_token is not null
    union select verification_token from registrations where verification_token is not null
    union select edit_token from form_responses where edit_token is not null
    union select invite_token from players where invite_token is not null`).map((r) => r.v as string);
  const phones = (await sql`select contact_phone as v from registrations where contact_phone is not null`).map(
    (r) => r.v as string,
  );
  const parties = (await sql`select id from registrations where deleted_at is null order by id`).map((r) =>
    Number(r.id),
  );
  await sql.end();
  return {
    parties,
    list: [
      ...emails.map((v) => ({ kind: 'email', v })),
      // TLD-less / malformed addresses a key-less text mask cannot see
      { kind: 'email', v: 'alice@examplecom' },
      ...tokens.map((v) => ({ kind: 'token', v })),
      ...phones.map((v) => ({ kind: 'phone', v })),
      { kind: 'phone', v: '+60 17-555 0101' },
      { kind: 'phone', v: '0123456789' },
      { kind: 'phone', v: '+65 9000 0000' },
      // credentials quoted in the inbound reply (form-edit and verify links)
      { kind: 'token', v: 'EDITSECRET000000000001' },
      { kind: 'token', v: 'VERSECRET000000000001' },
    ],
  };
}

function urls(parties: number[]) {
  const u: string[] = [`${C}/audience`, `${C}/audience?grain=seats`];
  for (const v of VIEWS) u.push(`${C}/audience?view=${v}`, `${C}/audience?grain=seats&view=${v}`);
  for (const q of ['alice', 'gmail', '9123', 'kai', 'ORC']) u.push(`${C}/audience?q=${q}`, `${C}/audience?grain=seats&q=${q}`);
  for (const id of parties) u.push(`${C}/audience/${id}`);
  return u;
}

async function sweep(request: APIRequestContext, list: { kind: string; v: string }[], targets: string[]) {
  const hits: Record<string, { kind: string; v: string; where: string }[]> = {};
  const status: Record<string, number[]> = {};
  for (const url of targets) {
    const html = await request.get(url, { maxRedirects: 0 });
    // The HTML carries the initial RSC flight payload inline (self.__next_f);
    // a bare `RSC: 1` fetch is 307'd by Next without a matching `_rsc`, so the
    // client-navigation payload is checked in the browser flows instead.
    status[url] = [html.status()];
    const body = await html.text();
    if (!body.includes('self.__next_f')) throw new Error(`no flight payload in ${url}`);
    const lower = body.toLowerCase();
    for (const s of list) {
      let at = lower.indexOf(s.v.toLowerCase());
      while (at >= 0) {
        (hits[url] ??= []).push({ ...s, where: body.slice(Math.max(0, at - 90), at + s.v.length + 40) });
        at = lower.indexOf(s.v.toLowerCase(), at + 1);
      }
    }
  }
  return { hits, status };
}


test('VIEWER: no contact detail or credential in any Audience or record payload', async ({ page }) => {
  test.setTimeout(900_000);
  const { parties, list } = await secrets();
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  const { hits, status } = await sweep(page.request, list, urls(parties));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/viewer-payload.json`, JSON.stringify({ status, hits }, null, 2));
  const bad = Object.entries(status).filter(([, s]) => s[0] !== 200);
  expect(bad, 'every page is 200 for a viewer').toEqual([]);
  expect(hits).toEqual({});
});

test('ADMIN twin: the same sweep finds the planted values', async ({ page }) => {
  test.setTimeout(900_000);
  const { parties, list } = await secrets();
  await signIn(page, 'committee@example.test', 'qa-admin-pass');
  const { hits } = await sweep(page.request, list, [`${C}/audience`, `${C}/audience?grain=seats`, ...parties.map((id) => `${C}/audience/${id}`)]);
  writeFileSync(`${OUT}/admin-payload.json`, JSON.stringify(hits, null, 2));
  const found = new Set(Object.values(hits).flat().map((h) => h.v));
  // The planted ones on Alice's record and the party list
  for (const v of ['alice@example.test', '+65 9123 4567', 'alice@examplecom', 'bernard.seat@example.test', 'kai.hidden@example.test']) {
    expect(found.has(v), v).toBe(true);
  }
});
