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
 * Composite foreign keys — spec/domain.md §5.2, decision 27.
 *
 * `registrations` and `attendees` each carry both `show_id` and `segment_id`
 * because almost every query filters on one or the other. The risk that
 * denormalisation creates is drift: an attendee whose segment disagrees with its
 * registration's, or a registration pointing at a segment belonging to a
 * different show. Either corrupts every capacity count in §7.2 **silently**,
 * which is the worst way for it to happen.
 *
 * Postgres makes both impossible with no triggers and no application checks. The
 * point of these tests is that the database refuses — not that the application
 * remembers to ask.
 */

describe('composite foreign keys refuse drift', () => {
  let concertId: number;
  let showOne: number;
  let showTwo: number;
  let segmentOne: number;
  let segmentTwo: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showOne = await createShow(concertId, 100);
    showTwo = await createShow(concertId, 100);
    segmentOne = await createSegment(showOne, { audienceMode: 'PUBLIC', capacity: 50 });
    segmentTwo = await createSegment(showTwo, { audienceMode: 'PUBLIC', capacity: 50 });
  });

  it('rejects a registration in a segment belonging to a different show', async () => {
    await expect(
      sql`
        insert into registrations (show_id, segment_id, source, contact_name, status, requested_at)
        values (${showOne}::bigint, ${segmentTwo}::bigint, 'ADMIN', 'Wrong Show', 'CONFIRMED', now())
      `,
    ).rejects.toThrow(/registrations_segment_fk/);
  });

  it('rejects an attendee whose segment disagrees with its registration', async () => {
    const registrationId = await createRegistration({
      showId: showOne,
      segmentId: segmentOne,
    });

    await expect(
      withDirectAttendeeWrites(
        (tx) => tx`
          insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                                 allocation_type, status)
          values (${registrationId}::bigint, ${showOne}::bigint, ${segmentTwo}::bigint,
                  'Drifted', 'PROVIDED', 'EXTRA', 'CONFIRMED')
        `,
      ),
    ).rejects.toThrow(/attendees_registration_fk/);
  });

  it('rejects an attendee whose show disagrees with its registration', async () => {
    const registrationId = await createRegistration({
      showId: showOne,
      segmentId: segmentOne,
    });

    await expect(
      withDirectAttendeeWrites(
        (tx) => tx`
          insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                                 allocation_type, status)
          values (${registrationId}::bigint, ${showTwo}::bigint, ${segmentOne}::bigint,
                  'Drifted', 'PROVIDED', 'EXTRA', 'CONFIRMED')
        `,
      ),
    ).rejects.toThrow(/attendees_registration_fk/);
  });

  it('stops a registration being moved between segments by half', async () => {
    // §7.6 allows moving a registration between segments; §5.2 is what stops it
    // being done to the parent without the children.
    const registrationId = await createRegistration({
      showId: showOne,
      segmentId: segmentOne,
    });
    await withDirectAttendeeWrites(
      (tx) => tx`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status)
        values (${registrationId}::bigint, ${showOne}::bigint, ${segmentOne}::bigint,
                'Guest', 'PROVIDED', 'EXTRA', 'CONFIRMED')
      `,
    );

    const thirdSegment = await createSegment(showOne, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 40,
    });

    await expect(
      sql`
        update registrations set segment_id = ${thirdSegment}::bigint
         where id = ${registrationId}::bigint
      `,
    ).rejects.toThrow(/attendees_registration_fk/);

    // Parent and children together, in one transaction, is allowed.
    await sql.begin(async (tx) => {
      await tx`
        update attendees set segment_id = ${thirdSegment}::bigint
         where registration_id = ${registrationId}::bigint
      `;
      await tx`
        update registrations set segment_id = ${thirdSegment}::bigint
         where id = ${registrationId}::bigint
      `;
    });

    const [row] = await sql<{ segment_id: string }[]>`
      select segment_id from attendees where registration_id = ${registrationId}::bigint
    `;
    expect(Number(row.segment_id)).toBe(thirdSegment);
  });
});
