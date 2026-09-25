import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createRegistration, createSegment, createShow } from '../helpers/fixtures';
import { TEMPLATE_KEYS, TEMPLATE_PURPOSE, purposeFor } from '@/lib/email/templates';

/**
 * The pending-message key moves from template to **purpose** — spec/v3.md
 * §24.2, decision 52.
 *
 * Per template, a redraft under a different template did not conflict with the
 * first draft, so both sent (§20 finding 3). Per purpose it does. Superseding —
 * cancelling the old draft and pointing it at the new — is module `T`'s
 * behaviour; the database's is only that the second insert is **refused rather
 * than doubled**, which is what every existing `on conflict do nothing` insert
 * relies on.
 */

let registrationId: number;
let playerId: number;

const draft = (purpose: string | null, template: string | null, status = 'DRAFT') => sql`
  insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                            status)
  values (${registrationId}, ${purpose}::message_purpose, ${template}, 'to@example.test', 's',
          'b', ${status}::outbox_status)
  on conflict do nothing
  returning id
`;

beforeEach(async () => {
  await resetDb();
  const concertId = await createConcert();
  const showId = await createShow(concertId, 50);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  registrationId = await createRegistration({ showId, segmentId });
  [playerId] = await createPlayers(concertId, 1);
});

describe('email_outbox.purpose', () => {
  it('is required, with no default to fall back on', async () => {
    // A defaulted purpose would make unrelated messages collide under the index.
    await expect(
      sql`insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
          values (${registrationId}, 'reminder', 'to@example.test', 's', 'b', 'DRAFT')`,
    ).rejects.toThrow(/purpose/);

    const [col] = await sql<{ column_default: string | null; is_nullable: string }[]>`
      select column_default, is_nullable from information_schema.columns
       where table_name = 'email_outbox' and column_name = 'purpose'
    `;
    expect(col).toEqual({ column_default: null, is_nullable: 'NO' });
  });

  it('refuses a second pending message for the same purpose under another template', async () => {
    expect(await draft('TICKETS', 'public_ticket')).toHaveLength(1);
    // The bug: switching template used to add a second draft that also sent.
    expect(await draft('TICKETS', 'player_confirmation')).toHaveLength(0);
    // The same holds for the two wordings of one extras decision.
    expect(await draft('EXTRAS_DECISION', 'extras_granted')).toHaveLength(1);
    expect(await draft('EXTRAS_DECISION', 'extras_declined')).toHaveLength(0);
  });

  it('still allows different purposes side by side', async () => {
    expect(await draft('TICKETS', 'public_ticket')).toHaveLength(1);
    expect(await draft('VERIFICATION', 'public_verify')).toHaveLength(1);
    expect(await draft('REMINDER', 'reminder')).toHaveLength(1);
  });

  it('frees the purpose once the pending message is sent or cancelled', async () => {
    const [first] = await draft('TICKETS', 'public_ticket');
    await sql`update email_outbox set status = 'CANCELLED' where id = ${first.id}`;
    expect(await draft('TICKETS', 'player_confirmation')).toHaveLength(1);
  });

  it('applies the same key to player-addressed messages', async () => {
    const insert = () => sql`
      insert into email_outbox (player_id, purpose, template_key, to_email, subject, body_md, status)
      values (${playerId}, 'NOTES_DIGEST', 'player_notes_digest', 'p@example.test', 's', 'b', 'DRAFT')
      on conflict do nothing
      returning id
    `;
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
  });

  it('never collapses two replies, which a person wrote', async () => {
    // Superseding a reply would silently discard something a human composed.
    expect(await draft('REPLY', null, 'QUEUED')).toHaveLength(1);
    expect(await draft('REPLY', null, 'QUEUED')).toHaveLength(1);
  });

  it('requires a template for every purpose but REPLY', async () => {
    await expect(draft('REMINDER', null)).rejects.toThrow(/email_outbox_template_unless_reply/);
  });

  it('keeps the one-addressee check, so a row addressed to nobody still fails', async () => {
    await expect(
      sql`insert into email_outbox (purpose, template_key, to_email, subject, body_md, status)
          values ('REMINDER', 'reminder', 'x@example.test', 's', 'b', 'DRAFT')`,
    ).rejects.toThrow(/email_outbox_one_addressee/);
  });
});

describe('TEMPLATE_PURPOSE', () => {
  it('maps every template the app writes', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(TEMPLATE_PURPOSE[key], key).toBeDefined();
    }
  });

  it('agrees with the backfill in 0200, template by template', () => {
    const migration = readFileSync('drizzle/0200_v3_schema_delta.sql', 'utf8');
    const backfill = new Map(
      [...migration.matchAll(/when '([a-z_]+)'\s+then '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]),
    );
    for (const key of TEMPLATE_KEYS) {
      expect(backfill.get(key), key).toBe(TEMPLATE_PURPOSE[key]);
    }
    expect(backfill.get('feedback_form_link')).toBe('FEEDBACK');
  });

  it('refuses a template it does not know, rather than guessing', () => {
    expect(() => purposeFor('mystery')).toThrow(/No message purpose/);
    expect(purposeFor('public_ticket')).toBe('TICKETS');
  });
});
