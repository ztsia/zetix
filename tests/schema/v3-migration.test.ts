import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { assertLocalDatabase, sql } from '../helpers/db';

/**
 * `0200` against data shaped like production's — handoff items 2 and 3.
 *
 * Every other suite runs the migrations on empty tables, where a backfill has
 * nothing to backfill and a unique index nothing to refuse. This one builds a
 * scratch database **at V2** (every migration up to `0100`), seeds the rows
 * that make `0200` hard — two pending drafts for one party and purpose under
 * different templates, a SENDING row, the script-only `feedback_form_link` —
 * and only then applies `0200`.
 */

const SCRATCH = 'zetix_migration_0200_test';
const baseUrl = process.env.DATABASE_URL!;
assertLocalDatabase(baseUrl);

function urlFor(database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A migrations folder holding everything before V3, so a database can be built at V2. */
function v2Folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zetix-v2-migrations-'));
  mkdirSync(join(dir, 'meta'));
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx < 200);
  for (const e of journal.entries) {
    copyFileSync(join('drizzle', `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

let scratch: ReturnType<typeof postgres> | null = null;

async function freshV2Database() {
  await scratch?.end();
  await sql.unsafe(`drop database if exists ${SCRATCH} with (force)`);
  await sql.unsafe(`create database ${SCRATCH}`);
  scratch = postgres(urlFor(SCRATCH), { prepare: false, max: 1, onnotice: () => {} });
  await scratch.unsafe(`
    create extension if not exists citext;
    create extension if not exists pg_trgm;
    create extension if not exists pgcrypto;
  `);
  await migrate(drizzle(scratch), { migrationsFolder: v2Folder() });
  return scratch;
}

const applyV3 = (db: ReturnType<typeof postgres>) =>
  migrate(drizzle(db), { migrationsFolder: './drizzle' });

afterAll(async () => {
  await scratch?.end();
  await sql.unsafe(`drop database if exists ${SCRATCH} with (force)`);
});

/** A concert, show, public segment, one player, and two parties at V2's shape. */
async function seedV2(db: ReturnType<typeof postgres>) {
  const [{ id: concert }] = await db`
    insert into concerts (name, slug, status, timezone)
    values ('C', 'c', 'ACTIVE', 'Asia/Singapore') returning id`;
  const [{ id: show }] = await db`
    insert into shows (concert_id, name, status, capacity)
    values (${concert}, 'S', 'OPEN', 100) returning id`;
  const [{ id: segment }] = await db`
    insert into show_segments (show_id, name, audience_mode, capacity, extras_policy)
    values (${show}, 'Public', 'PUBLIC', 50, 'AUTO_FCFS') returning id`;
  const [{ id: player }] = await db`
    insert into players (concert_id, full_name, email, invite_token)
    values (${concert}, 'P', 'p@example.test', 'tok-p') returning id`;

  const party = async (email: string, requestedAt: string, createdAt: string) => {
    const [{ id }] = await db`
      insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                 status, requested_at, created_at)
      values (${show}, ${segment}, 'IMPORT', 'A', ${email}, 'CONFIRMED',
              ${requestedAt}::timestamptz, ${createdAt}::timestamptz)
      returning id`;
    await db.begin(async (tx) => {
      await tx`select set_config('zetix.granting', 'on', true)`;
      await tx`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status)
        values (${id}, ${show}, ${segment}, 'Guest', 'PROVIDED', 'EXTRA', 'CONFIRMED'),
               (${id}, ${show}, ${segment}, 'Guest 2', 'PROVIDED', 'EXTRA', 'CONFIRMED')`;
    });
    return Number(id);
  };

  const r1 = await party('one@example.test', '2026-09-01T10:00:00Z', '2026-09-02T08:00:00Z');
  const r2 = await party('two@example.test', '2026-09-03T11:00:00Z', '2026-09-04T09:00:00Z');

  const message = async (
    to: { registration?: number; player?: number },
    template: string,
    status: string,
    createdAt: string,
  ) => {
    const [{ id }] = await db`
      insert into email_outbox (registration_id, player_id, template_key, to_email, subject,
                                body_md, status, created_at, updated_at)
      values (${to.registration ?? null}, ${to.player ?? null}, ${template}, 'x@example.test',
              's', 'b', ${status}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
      returning id`;
    return Number(id);
  };

  return { concert: Number(concert), player: Number(player), r1, r2, message };
}

describe('0200 on a database that already holds V2 data', () => {
  beforeEach(async () => {
    await freshV2Database();
  });

  it('maps every template to its purpose, the script-only feedback_form_link included', async () => {
    const db = scratch!;
    const { r1, r2, player, message } = await seedV2(db);
    const ids = {
      confirmation: await message({ registration: r1 }, 'player_confirmation', 'SENT', '2026-09-05T00:00:00Z'),
      ticket: await message({ registration: r2 }, 'public_ticket', 'SENT', '2026-09-05T00:00:00Z'),
      verify: await message({ registration: r1 }, 'public_verify', 'SENT', '2026-09-05T00:00:00Z'),
      granted: await message({ registration: r1 }, 'extras_granted', 'SENT', '2026-09-05T00:00:00Z'),
      declined: await message({ registration: r2 }, 'extras_declined', 'SENT', '2026-09-05T00:00:00Z'),
      cancelled: await message({ registration: r1 }, 'registration_cancelled', 'SENT', '2026-09-05T00:00:00Z'),
      reminder: await message({ registration: r1 }, 'reminder', 'SENT', '2026-09-05T00:00:00Z'),
      feedback: await message({ registration: r1 }, 'feedback_request', 'SENT', '2026-09-05T00:00:00Z'),
      formLink: await message({ registration: r2 }, 'feedback_form_link', 'SENT', '2026-09-05T00:00:00Z'),
      digest: await message({ player }, 'player_notes_digest', 'SENT', '2026-09-05T00:00:00Z'),
    };

    await applyV3(db);

    const rows = await db<{ id: string; purpose: string }[]>`select id, purpose from email_outbox`;
    const purpose = Object.fromEntries(rows.map((r) => [Number(r.id), r.purpose]));
    expect(purpose[ids.confirmation]).toBe('TICKETS');
    expect(purpose[ids.ticket]).toBe('TICKETS');
    expect(purpose[ids.verify]).toBe('VERIFICATION');
    expect(purpose[ids.granted]).toBe('EXTRAS_DECISION');
    expect(purpose[ids.declined]).toBe('EXTRAS_DECISION');
    expect(purpose[ids.cancelled]).toBe('CANCELLATION');
    expect(purpose[ids.reminder]).toBe('REMINDER');
    expect(purpose[ids.feedback]).toBe('FEEDBACK');
    expect(purpose[ids.formLink]).toBe('FEEDBACK');
    expect(purpose[ids.digest]).toBe('NOTES_DIGEST');
  });

  it('cancels all but the newest pending message per party and purpose, and records each', async () => {
    const db = scratch!;
    const { r1, r2, player, message } = await seedV2(db);
    // The bug V3 fixes: one party, two pending drafts, two templates, one purpose.
    const olderDraft = await message({ registration: r1 }, 'player_confirmation', 'DRAFT', '2026-09-05T00:00:00Z');
    const newerQueued = await message({ registration: r1 }, 'public_ticket', 'QUEUED', '2026-09-06T00:00:00Z');
    // A SENDING row survives a newer draft: it is already in the dispatcher's hands.
    const sending = await message({ registration: r2 }, 'extras_granted', 'SENDING', '2026-09-05T00:00:00Z');
    const newerDraft = await message({ registration: r2 }, 'extras_declined', 'DRAFT', '2026-09-06T00:00:00Z');
    // Different purposes, and a lone player message, are untouched.
    const verify = await message({ registration: r1 }, 'public_verify', 'DRAFT', '2026-09-05T00:00:00Z');
    const digest = await message({ player }, 'player_notes_digest', 'DRAFT', '2026-09-05T00:00:00Z');

    await applyV3(db);

    const rows = await db<{ id: string; status: string; superseded_by_id: string | null; updated_at: Date }[]>`
      select id, status, superseded_by_id, updated_at from email_outbox order by id`;
    const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r]));

    expect(byId[olderDraft]).toMatchObject({ status: 'CANCELLED' });
    expect(Number(byId[olderDraft].superseded_by_id)).toBe(newerQueued);
    expect(byId[newerQueued]).toMatchObject({ status: 'QUEUED', superseded_by_id: null });

    expect(byId[sending]).toMatchObject({ status: 'SENDING', superseded_by_id: null });
    expect(byId[newerDraft]).toMatchObject({ status: 'CANCELLED' });
    expect(Number(byId[newerDraft].superseded_by_id)).toBe(sending);

    expect(byId[verify].status).toBe('DRAFT');
    expect(byId[digest].status).toBe('DRAFT');

    // The backfill did not touch `updated_at`, which the dispatcher's
    // stale-SENDING recovery reads.
    expect(new Date(byId[sending].updated_at).toISOString()).toBe('2026-09-05T00:00:00.000Z');

    const audit = await db<{ entity_id: string; action: string }[]>`
      select entity_id, action from audit_log order by entity_id`;
    expect(audit.map((a) => [Number(a.entity_id), a.action]).sort()).toEqual(
      [
        [olderDraft, 'outbox.superseded'],
        [newerDraft, 'outbox.superseded'],
      ].sort(),
    );

    // And the new index now holds.
    await expect(
      db`insert into email_outbox (registration_id, purpose, template_key, to_email, subject,
                                   body_md, status)
         values (${r1}, 'TICKETS', 'player_confirmation', 'x@example.test', 's', 'b', 'DRAFT')`,
    ).rejects.toThrow(/outbox_no_duplicate_pending/);
  });

  it('approves every existing party as of its creation, and dates every seat from its party', async () => {
    const db = scratch!;
    const { r1, r2 } = await seedV2(db);

    await applyV3(db);

    const parties = await db<{ id: string; approved_at: Date; created_at: Date }[]>`
      select id, approved_at, created_at from registrations order by id`;
    for (const p of parties) {
      expect(new Date(p.approved_at).toISOString()).toBe(new Date(p.created_at).toISOString());
    }

    const seats = await db<{ registration_id: string; requested_at: Date }[]>`
      select registration_id, requested_at from attendees order by id`;
    expect(seats).toHaveLength(4);
    const expected: Record<number, string> = {
      [r1]: '2026-09-01T10:00:00.000Z',
      [r2]: '2026-09-03T11:00:00.000Z',
    };
    for (const s of seats) {
      expect(new Date(s.requested_at).toISOString()).toBe(expected[Number(s.registration_id)]);
    }
  });

  it('refuses an unmapped template key and changes nothing', async () => {
    const db = scratch!;
    const { r1, message } = await seedV2(db);
    await message({ registration: r1 }, 'mystery_template', 'SENT', '2026-09-05T00:00:00Z');

    // drizzle wraps the database error as "Failed query: …" and keeps the
    // Postgres message on `cause`.
    const error = await applyV3(db).then(
      () => null,
      (e: unknown) => e as Error & { cause?: Error },
    );
    expect(error?.cause?.message ?? error?.message).toMatch(/mystery_template/);

    // `pnpm db:migrate` is one transaction, so the failure left V2 intact.
    const [{ n }] = await db<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_name = 'email_outbox' and column_name = 'purpose'`;
    expect(n).toBe(0);
  });
});
