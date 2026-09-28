import { beforeEach, describe, expect, it } from 'vitest';
import { segmentPool } from '@/db/allocation';
import {
  applyResponseEdit,
  loadEditableResponse,
  requestExtraSeats,
} from '@/lib/registrations/edit';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  json,
  setSystemSetting,
} from '../helpers/fixtures';
import { PUBLIC_FORM } from './fixtures';

/**
 * Editing a response — **every row of the §8.3.1 table, with a test each**.
 *
 * | Change | Allowed | Effect |
 * |---|---|---|
 * | Fix a guest's name or email | Yes | Updates the attendee; `needs_reissue` if `ticket_sent_at` |
 * | Fix contact name / phone | Yes | Updates the registration |
 * | **Remove** a guest | Yes | `CANCELLED`; the seat returns to the pool immediately |
 * | **Add** a guest | **No** | "request extra tickets" instead |
 *
 * The rule underneath all four: an edit may **correct or reduce, never
 * increase**. An edit form that can claim inventory is a second, unpoliced
 * allocation path.
 */

const SLUG = 'autumn-public';

let slugSeq = 0;

/**
 * A concert, show, public segment and form. **Both the concert name and the
 * form slug are unique per call**, because both carry unique indexes and a
 * second scenario in one test would otherwise collide on them rather than on
 * anything the test is about.
 */
async function scenario(capacity = 50, name = 'Test Concert') {
  const slug = `${SLUG}-${(slugSeq += 1)}`;
  const concertId = await createConcert(name);
  const showId = await createShow(concertId, capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: true,
  });
  const [form] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, kind, title, slug, schema, status)
    values (${segmentId}, 'PUBLIC', 'Come along', ${slug},
            ${json(PUBLIC_FORM)}::text::jsonb, 'OPEN')
    returning id
  `;
  return { concertId, showId, segmentId, formId: Number(form.id) };
}

/** A party of `names.length`, reachable by the returned edit token. */
async function party(
  ids: { showId: number; segmentId: number; formId: number },
  names: string[],
  editToken = 'edit-token-1',
) {
  const [response] = await sql<{ id: number }[]>`
    insert into form_responses (form_id, raw, form_schema, submitted_at, edit_token)
    values (${ids.formId}, ${json({})}::text::jsonb, ${json(PUBLIC_FORM)}::text::jsonb,
            now(), ${editToken})
    returning id
  `;
  const [registration] = await sql<{ id: number }[]>`
    insert into registrations (
      show_id, segment_id, source, form_response_id,
      contact_name, contact_email, status, requested_at
    ) values (
      ${ids.showId}, ${ids.segmentId}, 'FORM', ${response.id},
      'Alice Tan', 'alice@example.test', 'WAITLIST', now()
    )
    returning id
  `;
  await sql`
    select claim_seats(
      ${ids.segmentId}::bigint, ${registration.id}::bigint,
      ${json(names.map((full_name) => ({ full_name, allocation_type: 'EXTRA' })))}::jsonb,
      false::boolean
    )
  `;
  await sql`update registrations set status = 'CONFIRMED' where id = ${registration.id}`;
  return { registrationId: Number(registration.id), responseId: Number(response.id) };
}

async function seatsOf(registrationId: number) {
  return sql<{ id: number; full_name: string; status: string; needs_reissue: boolean }[]>`
    select id, full_name, status::text, needs_reissue
      from attendees where registration_id = ${registrationId} order by id
  `;
}

describe('the §8.3.1 edit table', () => {
  let ids: Awaited<ReturnType<typeof scenario>>;

  beforeEach(async () => {
    await resetDb();
    ids = await scenario();
  });

  describe('fix a guest name or email — allowed', () => {
    it('updates the attendee', async () => {
      const { registrationId } = await party(ids, ['Alice Tan', 'Bob Tan']);
      const loaded = await loadEditableResponse('edit-token-1');
      expect(loaded?.seats).toHaveLength(2);

      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((seat) => ({
          attendeeId: seat.attendeeId,
          fullName: seat.fullName === 'Bob Tan' ? 'Bobby Tan' : seat.fullName,
          email: null,
        })),
        raw: {},
      });
      expect(result).not.toHaveProperty('error');

      const seats = await seatsOf(registrationId);
      expect(seats.map((s) => s.full_name)).toEqual(['Alice Tan', 'Bobby Tan']);
    });

    /**
     * `tickets.md` §10.6 — the ticket somebody holds and the ticket we would
     * render must not silently diverge. The door is unaffected either way,
     * because check-in matches on `qr_token`.
     */
    it('flags needs_reissue when the ticket is already sent', async () => {
      const { registrationId } = await party(ids, ['Alice Tan']);
      await sql`update attendees set ticket_sent_at = now() where registration_id = ${registrationId}`;

      const loaded = await loadEditableResponse('edit-token-1');
      // A sent ticket closes editing to the registrant by default (§8.3.1).
      expect(loaded?.closedReason).toBe('TICKETS_SENT');
    });

    /**
     * Re-saving without touching a name must not manufacture reissue work. The
     * flag is about divergence, and nothing diverged.
     */
    it('does not flag a reissue when nothing changed', async () => {
      const { registrationId } = await party(ids, ['Alice Tan', 'Bob Tan']);
      const loaded = await loadEditableResponse('edit-token-1');

      await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((seat) => ({
          attendeeId: seat.attendeeId,
          fullName: seat.fullName,
          email: seat.email,
        })),
        raw: {},
      });

      const seats = await seatsOf(registrationId);
      expect(seats.every((s) => s.needs_reissue === false)).toBe(true);
    });
  });

  it('fix contact details — allowed', async () => {
    const { registrationId } = await party(ids, ['Alice Tan']);
    const loaded = await loadEditableResponse('edit-token-1');

    await applyResponseEdit('edit-token-1', {
      contactName: 'Alicia Tan',
      contactPhone: '+60123456789',
      custom: null,
      seats: loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
      raw: {},
    });

    const [row] = await sql<{ contact_name: string; contact_phone: string | null }[]>`
      select contact_name, contact_phone from registrations where id = ${registrationId}
    `;
    expect(row.contact_name).toBe('Alicia Tan');
    expect(row.contact_phone).toBe('+60123456789');
  });

  describe('remove a guest — allowed', () => {
    it('cancels the attendee and returns the seat to the pool immediately', async () => {
      const { registrationId } = await party(ids, ['Alice Tan', 'Bob Tan', 'Cara Tan']);
      const before = await segmentPool(ids.segmentId);

      const loaded = await loadEditableResponse('edit-token-1');
      const keep = loaded!.seats.filter((seat) => seat.fullName !== 'Bob Tan');

      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: keep.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
        raw: {},
      });
      expect(result).toMatchObject({ removed: 1 });

      const seats = await seatsOf(registrationId);
      expect(seats.find((s) => s.full_name === 'Bob Tan')?.status).toBe('CANCELLED');

      /**
       * **Nothing caches seat counts**, so the very next read reflects it —
       * there is no counter to drift (§8.3.1, §7.8).
       */
      const after = await segmentPool(ids.segmentId);
      expect(after.confirmed).toBe(before.confirmed - 1);
      expect(after.extras_pool).toBe(before.extras_pool + 1);
    });

    it('refuses to empty the party — that is a cancellation, not an edit', async () => {
      await party(ids, ['Alice Tan']);
      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: [],
        raw: {},
      });
      expect(result).toHaveProperty('error');
    });
  });

  /**
   * **The row that matters most.** The screen offers no add control, so a
   * payload carrying an unknown attendee id is crafted — and accepting it would
   * be exactly the unpoliced second allocation path §8.3.1 exists to prevent.
   */
  describe('add a guest — refused', () => {
    it('refuses an attendee id that is not on this registration', async () => {
      const { registrationId } = await party(ids, ['Alice Tan']);
      const other = await party(ids, ['Someone Else'], 'edit-token-2');
      const stolen = (await seatsOf(other.registrationId))[0];

      const loaded = await loadEditableResponse('edit-token-1');
      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: [
          ...loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
          { attendeeId: stolen.id, fullName: 'Gatecrasher', email: null },
        ],
        raw: {},
      });

      expect(result).toHaveProperty('error');
      // And nothing moved: the other party's seat is untouched.
      expect((await seatsOf(registrationId))).toHaveLength(1);
      expect((await seatsOf(other.registrationId))[0].full_name).toBe('Someone Else');
    });

    it('refuses a wholly invented attendee id', async () => {
      await party(ids, ['Alice Tan']);
      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: [{ attendeeId: 999_999, fullName: 'Nobody', email: null }],
        raw: {},
      });
      expect(result).toHaveProperty('error');
    });
  });

  describe('the response chain (§8.2.3, §8.2.4)', () => {
    it('inserts a new response chained by supersedes_id and never mutates raw', async () => {
      const { registrationId, responseId } = await party(ids, ['Alice Tan']);
      await sql`update form_responses set raw = ${json({ original: true })}::text::jsonb where id = ${responseId}`;

      const loaded = await loadEditableResponse('edit-token-1');
      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: 'Alicia Tan', email: null })),
        raw: { edited: true },
      });
      expect(result).not.toHaveProperty('error');

      const [original] = await sql<{ raw: { original?: boolean } }[]>`
        select raw from form_responses where id = ${responseId}
      `;
      expect(original.raw).toEqual({ original: true });

      const [chained] = await sql<{ id: number; supersedes_id: number; raw: unknown }[]>`
        select id, supersedes_id, raw from form_responses where supersedes_id = ${responseId}
      `;
      expect(Number(chained.supersedes_id)).toBe(responseId);
      expect(chained.raw).toEqual({ edited: true });

      const [reg] = await sql<{ form_response_id: number }[]>`
        select form_response_id from registrations where id = ${registrationId}
      `;
      expect(Number(reg.form_response_id)).toBe(Number(chained.id));
    });

    /**
     * An old token in an old confirmation email must not reopen a superseded
     * version and write it forward over later corrections.
     */
    it('stops accepting the superseded token', async () => {
      await party(ids, ['Alice Tan']);
      const loaded = await loadEditableResponse('edit-token-1');
      await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
        raw: {},
      });

      await expect(loadEditableResponse('edit-token-1')).resolves.toBeNull();
    });

    it('carries the pinned schema forward rather than re-pinning the current one', async () => {
      const { responseId } = await party(ids, ['Alice Tan']);
      await sql`
        update form_responses set form_schema = ${json({ kind: 'PUBLIC', blocks: [], pinned: 'old' })}::text::jsonb
        where id = ${responseId}
      `;
      // The live form moves on, as an admin editing it would.
      await sql`update registration_forms set schema_version = 2 where id = ${ids.formId}`;

      const loaded = await loadEditableResponse('edit-token-1');
      await applyResponseEdit('edit-token-1', {
        contactName: 'Alice Tan',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
        raw: {},
      });

      const [chained] = await sql<{ form_schema: { pinned?: string } }[]>`
        select form_schema from form_responses where supersedes_id = ${responseId}
      `;
      expect(chained.form_schema.pinned).toBe('old');
    });
  });

  describe('the editing window', () => {
    it('is closed once allow_edit_until has passed', async () => {
      await party(ids, ['Alice Tan']);
      await sql`
        update registration_forms set allow_edit_until = now() - interval '1 hour'
         where id = ${ids.formId}
      `;
      const loaded = await loadEditableResponse('edit-token-1');
      expect(loaded?.closedReason).toBe('WINDOW');

      const result = await applyResponseEdit('edit-token-1', {
        contactName: 'Nope',
        contactPhone: null,
        custom: null,
        seats: loaded!.seats.map((s) => ({ attendeeId: s.attendeeId, fullName: s.fullName, email: null })),
        raw: {},
      });
      expect(result).toHaveProperty('error');
    });

    it.each(['nope', '', '../etc/passwd'])('returns null for the bad token %j', async (bad) => {
      await expect(loadEditableResponse(bad)).resolves.toBeNull();
    });
  });
});

/**
 * "Request extra tickets" — the offer that replaces adding a guest.
 *
 * **A new request with a new `requested_at`, at the back of the FCFS queue.**
 * Keeping the original timestamp would let an early registrant reserve a queue
 * position for seats they had not yet asked for.
 */
describe('requestExtraSeats', () => {
  let ids: Awaited<ReturnType<typeof scenario>>;

  beforeEach(async () => {
    await resetDb();
    ids = await scenario();
    /**
     * Stated, never defaulted. `requestExtraSeats()` refuses when this does not
     * resolve — an unresolved cap must never read as "unlimited" — so a test
     * that omits it is testing the refusal, not the request.
     */
    await setSystemSetting('form.extra_rows_max', 3);
  });

  it('adds the seats to the same party, one party per email (spec/v3.md §25.5)', async () => {
    const { registrationId } = await party(ids, ['Alice Tan']);

    const result = await requestExtraSeats('edit-token-1', ['Dana Tan']);
    expect(result).toMatchObject({ requested: 1 });

    expect(await seatsOf(registrationId)).toHaveLength(2);
    const rows = await sql<{ id: number }[]>`
      select id from registrations where segment_id = ${ids.segmentId} and deleted_at is null
    `;
    expect(rows).toHaveLength(1);
  });

  it('puts the new seats at the back of the queue, and the party back in review', async () => {
    const { registrationId } = await party(ids, ['Alice Tan']);
    await sql`update registrations set requested_at = now() - interval '7 days', approved_at = now() where id = ${registrationId}`;
    await sql`update attendees set requested_at = now() - interval '7 days' where registration_id = ${registrationId}`;

    await requestExtraSeats('edit-token-1', ['Dana Tan']);

    const seats = await sql<{ requested_at: string }[]>`
      select requested_at::text from attendees where registration_id = ${registrationId} order by id
    `;
    // The original seat keeps its early position; the request lands after it.
    expect(new Date(seats[1].requested_at).getTime()).toBeGreaterThan(
      new Date(seats[0].requested_at).getTime() + 6 * 24 * 3600_000,
    );
    const [party_] = await sql<{ approved: boolean }[]>`
      select approved_at is not null as approved from registrations where id = ${registrationId}
    `;
    expect(party_.approved).toBe(false);
  });

  it('routes the seats through claim_seats(), so capacity still decides', async () => {
    // A distinct name: `createConcert` derives the slug from it, and the slug is unique.
    const tight = await scenario(1, 'Tight Concert');
    await party(tight, ['Alice Tan'], 'edit-token-tight');

    const result = await requestExtraSeats('edit-token-tight', ['Dana Tan', 'Eve Tan']);
    expect(result).toMatchObject({ requested: 2, granted: 0 });

    const pool = await segmentPool(tight.segmentId);
    expect(pool.confirmed).toBe(1);
  });

  /**
   * **The three guards `requestExtraSeats()` was missing**, each found by a QA
   * pass driving the real function.
   *
   * It is the *claiming* half of this screen, and an earlier version checked
   * only that the edit token resolved — none of the limits its sibling
   * `applyResponseEdit()` applies eleven lines above it. That made it a second
   * allocation path reachable from a public URL with none of the guards, which
   * is precisely what §8.3.1 exists to prevent.
   */
  describe('the limits that close the edit screen close this too', () => {
    it('caps the request at form.extra_rows_max', async () => {
      await party(ids, ['Alice Tan']);
      await setSystemSetting('form.extra_rows_max', 2);

      const result = await requestExtraSeats(
        'edit-token-1',
        Array.from({ length: 40 }, (_, i) => `Crowd ${i + 1}`),
      );
      expect(result).toHaveProperty('error');

      // And nothing was granted: QA drained a segment this way, 40 for 40.
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from attendees where segment_id = ${ids.segmentId}
      `;
      expect(n).toBe(1);
    });

    it('grants up to the cap', async () => {
      await party(ids, ['Alice Tan']);
      await setSystemSetting('form.extra_rows_max', 2);

      const result = await requestExtraSeats('edit-token-1', ['Dana Tan', 'Eve Tan']);
      expect(result).toMatchObject({ requested: 2 });
    });

    /**
     * A cap that does not resolve refuses, exactly as `limits.ts` refuses rather
     * than rendering an invented number. An unresolved cap defaulting to
     * "unlimited" is the bug this guard was written for.
     */
    it('refuses when the cap resolves to nothing', async () => {
      await party(ids, ['Alice Tan']);
      await sql`delete from system_settings where key = 'form.extra_rows_max'`;
      await expect(requestExtraSeats('edit-token-1', ['Dana Tan'])).resolves.toHaveProperty('error');
    });

    it('refuses once the party tickets are sent', async () => {
      const { registrationId } = await party(ids, ['Alice Tan']);
      await setSystemSetting('form.extra_rows_max', 2);
      await sql`update attendees set ticket_sent_at = now() where registration_id = ${registrationId}`;

      const result = await requestExtraSeats('edit-token-1', ['Dana Tan']);
      expect(result).toHaveProperty('error');
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from attendees where segment_id = ${ids.segmentId}
      `;
      expect(n).toBe(1);
    });

    it('refuses after allow_edit_until has passed', async () => {
      await party(ids, ['Alice Tan']);
      await setSystemSetting('form.extra_rows_max', 2);
      await sql`
        update registration_forms set allow_edit_until = now() - interval '1 hour'
         where id = ${ids.formId}
      `;

      const result = await requestExtraSeats('edit-token-1', ['Dana Tan']);
      expect(result).toHaveProperty('error');
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from attendees where segment_id = ${ids.segmentId}
      `;
      expect(n).toBe(1);
    });
  });

  it('refuses an empty request', async () => {
    await party(ids, ['Alice Tan']);
    await expect(requestExtraSeats('edit-token-1', ['  '])).resolves.toHaveProperty('error');
  });
});
