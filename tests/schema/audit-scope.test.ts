import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * `0201` — the concert scope of `audit_log` (spec/v3.md §23.1, §23.6).
 *
 * The Activity log is read per concert, and about sixty call sites write audit
 * rows without saying which concert they belong to. `audit_log_fill_concert`
 * derives it on insert. These tests write rows the way the existing call sites
 * do — entity type and id only — and check the scope lands.
 */

let concertId: number;
let otherConcertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Scoped');
  otherConcertId = await createConcert('Elsewhere');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100 });
});

async function audit(entityType: string, entityId: string | number | null, concert?: number) {
  const [row] = await sql<{ concert_id: string | null }[]>`
    insert into audit_log (action, entity_type, entity_id, concert_id)
    values ('test.written', ${entityType}, ${entityId == null ? null : String(entityId)},
            ${concert ?? null})
    returning concert_id
  `;
  return row.concert_id == null ? null : Number(row.concert_id);
}

describe('audit_log_fill_concert', () => {
  it('scopes every entity type the code writes today', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    const [attendee] = await withDirectAttendeeWrites(
      (tx) => tx<{ id: string }[]>`
        insert into attendees (registration_id, show_id, segment_id, full_name,
                               name_source, allocation_type, status)
        values (${registrationId}, ${showId}, ${segmentId}, 'A', 'PROVIDED', 'BASE',
                'CONFIRMED')
        returning id
      `,
    );
    const [playerId] = await createPlayers(concertId, 1);
    const [template] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
                                    page_width_pt, page_height_pt, layout)
      values (${concertId}, 'T', 1, 'NONE', 100, 100, '{"elements":[]}'::jsonb)
      returning id
    `;

    expect(await audit('concert', concertId)).toBe(concertId);
    expect(await audit('concerts', concertId)).toBe(concertId);
    expect(await audit('show', showId)).toBe(concertId);
    expect(await audit('shows', showId)).toBe(concertId);
    expect(await audit('show_segment', segmentId)).toBe(concertId);
    expect(await audit('registration', registrationId)).toBe(concertId);
    expect(await audit('attendee', attendee.id)).toBe(concertId);
    expect(await audit('player', playerId)).toBe(concertId);
    expect(await audit('ticket_template', template.id)).toBe(concertId);
  });

  it('scopes an outbox row through its registration', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    const [row] = await sql<{ id: string }[]>`
      insert into email_outbox (registration_id, to_email, template_key, purpose,
                                subject, body_md, status)
      values (${registrationId}, 'a@example.com', 'tickets', 'TICKETS', 's', 'b', 'DRAFT')
      returning id
    `;
    expect(await audit('email_outbox', row.id)).toBe(concertId);
  });

  it('never overrides a concert the writer passed', async () => {
    expect(await audit('show', showId, otherConcertId)).toBe(otherConcertId);
  });

  it('leaves global and unresolvable rows unscoped rather than failing the insert', async () => {
    expect(await audit('system_setting', 'admin.typed_confirm_above')).toBeNull();
    expect(await audit('email_template', 'tickets')).toBeNull();
    expect(await audit('portal_notes', null)).toBeNull();
    expect(await audit('registration', 999_999)).toBeNull();
    expect(await audit('unknown_kind', 1)).toBeNull();
  });

  it('keeps the scope after the entity is permanently deleted', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    await audit('registration', registrationId);
    await sql`delete from registrations where id = ${registrationId}`;

    const [row] = await sql<{ concert_id: string }[]>`
      select concert_id from audit_log
       where entity_type = 'registration' and entity_id = ${String(registrationId)}
    `;
    expect(Number(row.concert_id)).toBe(concertId);
  });
});
