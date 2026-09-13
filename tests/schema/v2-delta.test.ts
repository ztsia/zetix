import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * The V2 schema delta — module `J`, `drizzle/0100_v2_schema_delta.sql`.
 *
 * Everything here is a **database** property: a constraint or an index that
 * V2's handlers will rely on and must not have to re-implement. `tests/schema/`
 * is where those live, because the schema freezes when this branch merges
 * (`modules-v2.md` §4) and a later module cannot fix one of them on its own.
 *
 * The outbox half of the delta is in `outbox.test.ts`, beside the V1 property it
 * extends.
 */

/** A concert with one public segment, one player-invited segment, and a show. */
async function scaffold() {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  const publicSegmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 50,
  });
  const playerSegmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 50,
  });
  return { concertId, showId, publicSegmentId, playerSegmentId };
}

describe('shows.ends_at is nullable, and takes no default — decision 41', () => {
  let showId: number;

  beforeEach(async () => {
    await resetDb();
    ({ showId } = await scaffold());
  });

  it('leaves a show with no end time rather than inventing one', async () => {
    // `createShow` sets `starts_at` and nothing else. Nothing anywhere may infer
    // a duration from it: a concert with an interval runs well past its nominal
    // length, and a portal flipping to "how was your evening?" mid-performance
    // is worse than one that waits for a human (spec/v2.md §13.2.1).
    const [row] = await sql<{ ends_at: string | null; starts_at: string | null }[]>`
      select ends_at, starts_at from shows where id = ${showId}::bigint
    `;
    expect(row.starts_at).not.toBeNull();
    expect(row.ends_at).toBeNull();
  });

  it('has no column default that a later insert could pick up', async () => {
    const [row] = await sql<{ column_default: string | null; is_nullable: string }[]>`
      select column_default, is_nullable
        from information_schema.columns
       where table_name = 'shows' and column_name = 'ends_at'
    `;
    expect(row.column_default).toBeNull();
    expect(row.is_nullable).toBe('YES');
  });

  it('accepts one when an admin enters it', async () => {
    await sql`
      update shows set ends_at = starts_at + interval '2 hours' where id = ${showId}::bigint
    `;
    const [row] = await sql<{ ends_at: string | null }[]>`
      select ends_at from shows where id = ${showId}::bigint
    `;
    expect(row.ends_at).not.toBeNull();
  });
});

describe('a registration form has exactly one parent — spec/domain.md §5.1', () => {
  let showId: number;
  let publicSegmentId: number;

  beforeEach(async () => {
    await resetDb();
    ({ showId, publicSegmentId } = await scaffold());
  });

  const insertForm = (
    kind: string,
    parents: { segmentId?: number | null; showId?: number | null },
    slug: string,
  ) => sql`
    insert into registration_forms (segment_id, show_id, kind, title, slug, status)
    values (${parents.segmentId ?? null}, ${parents.showId ?? null}, ${kind}::form_kind,
            'A form', ${slug}, 'DRAFT')
    returning id, schema_version
  `;

  it('accepts a PLAYER or PUBLIC form on a segment', async () => {
    await expect(
      insertForm('PUBLIC', { segmentId: publicSegmentId }, 'public-1'),
    ).resolves.toHaveLength(1);
    await expect(
      insertForm('PLAYER', { segmentId: publicSegmentId }, 'player-1'),
    ).resolves.toHaveLength(1);
  });

  it('accepts a FEEDBACK form on a show', async () => {
    // §13.5: a feedback form creates no seats, so it hangs off the show rather
    // than off a segment. Segment is never shown to the audience anyway (§13.3).
    await expect(insertForm('FEEDBACK', { showId }, 'feedback-1')).resolves.toHaveLength(1);
  });

  it('refuses a registration form with no segment', async () => {
    // `segment_id` became nullable for feedback's sake. Without the check, that
    // change would quietly permit a player form with nowhere to put its seats.
    await expect(insertForm('PUBLIC', {}, 'orphan-1')).rejects.toThrow(
      /registration_forms_one_parent/,
    );
  });

  it('refuses a feedback form attached to a segment', async () => {
    await expect(
      insertForm('FEEDBACK', { segmentId: publicSegmentId }, 'feedback-2'),
    ).rejects.toThrow(/registration_forms_one_parent/);
  });

  it('refuses a form attached to both', async () => {
    await expect(
      insertForm('PUBLIC', { segmentId: publicSegmentId, showId }, 'both-1'),
    ).rejects.toThrow(/registration_forms_one_parent/);
  });

  it('starts schema_version at 1 so a response has something to pin', async () => {
    const [row] = await insertForm('PUBLIC', { segmentId: publicSegmentId }, 'versioned');
    expect(Number(row.schema_version)).toBe(1);
  });
});

describe('form_responses — spec/v2.md §8.2.4, §8.3, §8.3.1', () => {
  let formId: number;
  let otherFormId: number;

  beforeEach(async () => {
    await resetDb();
    const { publicSegmentId } = await scaffold();
    const rows = await sql<{ id: number }[]>`
      insert into registration_forms (segment_id, kind, title, slug, status)
      values (${publicSegmentId}::bigint, 'PUBLIC', 'Round 1', 'round-1', 'OPEN'),
             (${publicSegmentId}::bigint, 'PUBLIC', 'Round 2', 'round-2', 'OPEN')
      returning id
    `;
    [formId, otherFormId] = rows.map((r) => Number(r.id));
  });

  const respond = (identityKey: string | null, form = formId) => sql<{ id: number }[]>`
    insert into form_responses (form_id, raw, form_schema, identity_key, submitted_at)
    values (${form}::bigint, '{"a":1}'::jsonb, '{"blocks":[]}'::jsonb, ${identityKey}, now())
    returning id
  `;

  it('will not store a response without the schema it was answered against', async () => {
    // §8.2.4: without the pin, an admin renaming a question retroactively
    // changes what every earlier answer meant, and the export reshapes itself
    // between two downloads of "the same" data.
    await expect(
      sql`
        insert into form_responses (form_id, raw, identity_key, submitted_at)
        values (${formId}::bigint, '{}'::jsonb, null, now())
      `,
    ).rejects.toThrow(/null value in column "form_schema"/);
  });

  it('refuses a second response from the same identity on the same form', async () => {
    // §8.3: this is what makes `one_response_per_identity` real. A read-then-
    // write check in the handler is a race at exactly the moment scarce seats
    // attract double-clicks.
    await expect(respond('someone@example.test')).resolves.toHaveLength(1);
    await expect(respond('someone@example.test')).rejects.toThrow(/form_responses_identity_key/);
  });

  it('scopes the identity to one form, so round 2 is a separate response', async () => {
    // A second registration round is a new form on the same segment
    // (spec/domain.md §5.1), and the same person may answer both.
    await expect(respond('someone@example.test')).resolves.toHaveLength(1);
    await expect(respond('someone@example.test', otherFormId)).resolves.toHaveLength(1);
  });

  it('lets a form that does not limit by identity take many responses', async () => {
    // Partial index: two nulls must not conflict, or an unlimited form would
    // accept exactly one submission.
    await expect(respond(null)).resolves.toHaveLength(1);
    await expect(respond(null)).resolves.toHaveLength(1);
    await expect(respond(null)).resolves.toHaveLength(1);
  });

  it('chains an edit to the response it replaces rather than mutating raw', async () => {
    // §8.3.1: `raw` is the receipt of what someone actually typed and a dispute
    // is settled from it, so an edit inserts a new row.
    const [first] = await respond('editor@example.test');
    const [second] = await sql<{ id: number }[]>`
      insert into form_responses (form_id, raw, form_schema, supersedes_id, submitted_at)
      values (${formId}::bigint, '{"a":2}'::jsonb, '{"blocks":[]}'::jsonb,
              ${first.id}::bigint, now())
      returning id
    `;
    const [row] = await sql<{ supersedes_id: number | null; raw: { a: number } }[]>`
      select supersedes_id, raw from form_responses where id = ${second.id}::bigint
    `;
    expect(Number(row.supersedes_id)).toBe(Number(first.id));

    const [original] = await sql<{ raw: { a: number } }[]>`
      select raw from form_responses where id = ${first.id}::bigint
    `;
    expect(original.raw).toEqual({ a: 1 });
  });
});

describe('registration verification — spec/v2.md §8.1.4', () => {
  let showId: number;
  let publicSegmentId: number;
  let registrationId: number;

  beforeEach(async () => {
    await resetDb();
    ({ showId, publicSegmentId } = await scaffold());
    registrationId = await createRegistration({ showId, segmentId: publicSegmentId });
  });

  it('leaves a registration unverified without holding up its seats', async () => {
    // Verification gates the *email*, never the seat: seats are scarce, and
    // holding them for an unclicked link would give them away.
    const [row] = await sql<{ status: string; email_verified_at: string | null }[]>`
      select status, email_verified_at from registrations where id = ${registrationId}::bigint
    `;
    expect(row.status).toBe('CONFIRMED');
    expect(row.email_verified_at).toBeNull();
  });

  it('refuses two registrations sharing a verification token', async () => {
    // The token is a URL-reachable secret, exactly like `players.invite_token`.
    // Two registrations behind one link would verify the wrong party's email.
    const other = await createRegistration({ showId, segmentId: publicSegmentId });
    await sql`
      update registrations set verification_token = 'shared-token'
       where id = ${registrationId}::bigint
    `;
    await expect(
      sql`update registrations set verification_token = 'shared-token' where id = ${other}::bigint`,
    ).rejects.toThrow(/registrations_verification_token_key/);
  });

  it('lets every ungated registration leave the token null', async () => {
    // Player forms do not verify and imports skip it entirely, so most rows
    // never get a token — and nulls must not conflict with each other.
    const a = await createRegistration({ showId, segmentId: publicSegmentId });
    const b = await createRegistration({ showId, segmentId: publicSegmentId });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registrations
       where id in (${a}::bigint, ${b}::bigint) and verification_token is null
    `;
    expect(n).toBe(2);
  });
});

describe('custom answers are stored where screens can read them — §8.2.3', () => {
  let showId: number;
  let publicSegmentId: number;
  let registrationId: number;

  beforeEach(async () => {
    await resetDb();
    ({ showId, publicSegmentId } = await scaffold());
    registrationId = await createRegistration({ showId, segmentId: publicSegmentId });
  });

  it('holds party-level answers on the registration and per-seat ones on the attendee', async () => {
    // The duplication of `form_responses.raw` is deliberate: `raw` exists only
    // for `source = FORM`, so an admin table reading it would show blanks for
    // every imported and admin-created registration — which is most of them.
    await sql`
      update registrations set custom = '{"accessibility":"wheelchair"}'::jsonb
       where id = ${registrationId}::bigint
    `;
    await withDirectAttendeeWrites(async (tx) => {
      await tx`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status, custom)
        values (${registrationId}::bigint, ${showId}::bigint, ${publicSegmentId}::bigint,
                'Guest', 'PROVIDED', 'EXTRA', 'CONFIRMED', '{"meal":"vegetarian"}'::jsonb)
      `;
    });

    const [reg] = await sql<{ custom: Record<string, string> }[]>`
      select custom from registrations where id = ${registrationId}::bigint
    `;
    expect(reg.custom).toEqual({ accessibility: 'wheelchair' });

    const [att] = await sql<{ custom: Record<string, string> }[]>`
      select custom from attendees where registration_id = ${registrationId}::bigint
    `;
    expect(att.custom).toEqual({ meal: 'vegetarian' });
  });

  it('leaves both null for a registration that answered nothing custom', async () => {
    const [row] = await sql<{ custom: unknown }[]>`
      select custom from registrations where id = ${registrationId}::bigint
    `;
    expect(row.custom).toBeNull();
  });
});

describe('feedback_responses — spec/v2.md §13.5', () => {
  let showId: number;
  let formId: number;
  let attendeeId: number;
  let otherAttendeeId: number;

  beforeEach(async () => {
    await resetDb();
    const scaffolded = await scaffold();
    showId = scaffolded.showId;
    const registrationId = await createRegistration({
      showId,
      segmentId: scaffolded.publicSegmentId,
    });
    const [form] = await sql<{ id: number }[]>`
      insert into registration_forms (show_id, kind, title, slug, status)
      values (${showId}::bigint, 'FEEDBACK', 'How was your evening?', 'feedback', 'OPEN')
      returning id
    `;
    formId = Number(form.id);

    const rows = await withDirectAttendeeWrites(
      async (tx) => await tx<{ id: number }[]>`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status)
        values (${registrationId}::bigint, ${showId}::bigint,
                ${scaffolded.publicSegmentId}::bigint, 'Alice', 'PROVIDED', 'EXTRA', 'CONFIRMED'),
               (${registrationId}::bigint, ${showId}::bigint,
                ${scaffolded.publicSegmentId}::bigint, 'Bob', 'PROVIDED', 'EXTRA', 'CONFIRMED')
        returning id
      `,
    );
    [attendeeId, otherAttendeeId] = rows.map((r) => Number(r.id));
  });

  const respond = (attendee: number) => sql<{ id: number }[]>`
    insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema)
    values (${formId}::bigint, ${attendee}::bigint, ${showId}::bigint,
            '{"rating":5}'::jsonb, '{"blocks":[]}'::jsonb)
    returning id
  `;

  it('takes one response per attendee, not per registration', async () => {
    // "How was your evening?" is not a group answer, and a party of four that
    // split up at the interval has four of them.
    await expect(respond(attendeeId)).resolves.toHaveLength(1);
    await expect(respond(otherAttendeeId)).resolves.toHaveLength(1);
  });

  it('refuses a second response from the same attendee to the same form', async () => {
    await respond(attendeeId);
    await expect(respond(attendeeId)).rejects.toThrow(
      /feedback_responses_attendee_form_key/,
    );
  });

  it('pins the schema the answers were given against', async () => {
    await expect(
      sql`
        insert into feedback_responses (form_id, attendee_id, show_id, answers)
        values (${formId}::bigint, ${attendeeId}::bigint, ${showId}::bigint, '{}'::jsonb)
      `,
    ).rejects.toThrow(/null value in column "form_schema"/);
  });

  it('maintains updated_at through the shared trigger', async () => {
    // Every mutable table carries the trigger rather than trusting each writer
    // (drizzle/0001). A column only some writers maintain is worse than none.
    const [row] = await respond(attendeeId);
    const [before] = await sql<{ updated_at: string }[]>`
      select updated_at from feedback_responses where id = ${row.id}::bigint
    `;
    await sql`
      update feedback_responses set answers = '{"rating":4}'::jsonb
       where id = ${row.id}::bigint
    `;
    const [after] = await sql<{ updated_at: string }[]>`
      select updated_at from feedback_responses where id = ${row.id}::bigint
    `;
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });
});

describe('registrations_no_duplicate_import — spec/import.md §9.2, decision 33', () => {
  let showId: number;
  let publicSegmentId: number;
  let playerSegmentId: number;

  /**
   * A Google Forms export is cumulative: the round 2 download is round 1 plus
   * the new responses. `fix/import-reimport-dedup` closed the hole in
   * application code and deferred this index only because a migration before
   * 19 Sep meant a manual deploy; that reason expired with the concert
   * (`modules-v2.md` §6).
   */
  const AT = '2026-09-01T10:00:00.123456+00';

  const importParty = (segmentId: number, email: string | null, at: string = AT) => sql`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                               status, requested_at)
    values (${showId}::bigint, ${segmentId}::bigint, 'IMPORT', 'A Party', ${email},
            'CONFIRMED', ${at}::text::timestamptz)
    returning id
  `;

  beforeEach(async () => {
    await resetDb();
    ({ showId, publicSegmentId, playerSegmentId } = await scaffold());
  });

  it('refuses the same party twice from a re-uploaded sheet', async () => {
    await expect(importParty(publicSegmentId, 'party@example.test')).resolves.toHaveLength(1);
    await expect(importParty(publicSegmentId, 'party@example.test')).rejects.toThrow(
      /registrations_no_duplicate_import/,
    );
  });

  it('folds case, because the same person types their address either way', async () => {
    // `contact_email` is citext, so this is the type doing the work rather than
    // every call site remembering to lower(). The application-side dedup keys a
    // Map, where citext does not save it — hence both halves exist.
    await importParty(publicSegmentId, 'party@example.test');
    await expect(importParty(publicSegmentId, 'PARTY@EXAMPLE.TEST')).rejects.toThrow(
      /registrations_no_duplicate_import/,
    );
  });

  it('lets the same address register again with a new timestamp', async () => {
    // Round 2 is a genuinely new response. Email alone would merge a person's
    // two rounds into one oversized party; the timestamp is what separates them.
    await importParty(publicSegmentId, 'party@example.test');
    await expect(
      importParty(publicSegmentId, 'party@example.test', '2026-09-08T10:00:00+00'),
    ).resolves.toHaveLength(1);
  });

  it('scopes to the segment, since one import run is one segment', async () => {
    await importParty(publicSegmentId, 'party@example.test');
    await expect(importParty(playerSegmentId, 'party@example.test')).resolves.toHaveLength(1);
  });

  it('re-imports a deleted party, because a delete means it should not have existed', async () => {
    const [row] = await importParty(publicSegmentId, 'party@example.test');
    await sql`update registrations set deleted_at = now() where id = ${row.id}::bigint`;
    await expect(importParty(publicSegmentId, 'party@example.test')).resolves.toHaveLength(1);
  });

  it('still counts a cancelled party as imported', async () => {
    // QA failed the reverse of this once and was right to: a cancellation can be
    // restored (spec/allocation.md §7.9), and cancel → re-import → restore left
    // one form response holding two CONFIRMED registrations and four tickets.
    const [row] = await importParty(publicSegmentId, 'party@example.test');
    await sql`update registrations set status = 'CANCELLED' where id = ${row.id}::bigint`;
    await expect(importParty(publicSegmentId, 'party@example.test')).rejects.toThrow(
      /registrations_no_duplicate_import/,
    );
  });

  it('cannot dedup a party with no email, which is the known limit', async () => {
    // Two nulls never conflict in Postgres. §9.2 gives such a party a row-scoped
    // key that nothing outside the file can match, so it re-imports every round
    // and the importer reports it as a WARNING rather than swallowing it.
    await expect(importParty(publicSegmentId, null)).resolves.toHaveLength(1);
    await expect(importParty(publicSegmentId, null)).resolves.toHaveLength(1);
  });
});
