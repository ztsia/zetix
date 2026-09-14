import { beforeEach, describe, expect, it } from 'vitest';
import { resolveRegistrant } from '@/lib/forms/registrant';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  json,
  seedAttendees,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * Resolving `?k={token}` on a player form (spec/v2.md §8.1, §8.1.1).
 *
 * Two properties carry the weight here:
 *
 * 1. **The token is scoped to the concert.** A valid token from another event
 *    must not resolve, or the form prefills a stranger onto this concert.
 * 2. **`baseAlreadyClaimed` agrees with `claim_seats()`**, not with the prose
 *    in `allocation.md` §7.2. Where they differ the engine decides, so the
 *    tests below check the count against what the engine actually grants rather
 *    than against a number written out by hand.
 */

async function claimBase(segmentId: number, registrationId: number, n: number) {
  const [row] = await sql<{ claim_seats: { granted_base: number } }[]>`
    select claim_seats(
      ${segmentId}::bigint, ${registrationId}::bigint,
      ${json(Array.from({ length: n }, (_, i) => ({ full_name: `Seat ${i + 1}`, allocation_type: 'BASE' })))}::jsonb,
      false::boolean
    )
  `;
  return row.claim_seats;
}

describe('resolveRegistrant', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 120);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 120,
      baseQuota: 3,
      // Stated rather than defaulted: the engine refuses a segment configured
      // with nothing, which is the refusal these fixtures must not paper over.
      extrasPolicy: 'REVIEW',
    });
    playerIds = await createPlayers(concertId, 2);
  });

  const tokenFor = (index: number) => `tok-${concertId}-${index}`;

  describe('who is asking', () => {
    it('is anonymous with no token', async () => {
      await expect(resolveRegistrant(null, concertId, segmentId)).resolves.toEqual({
        kind: 'ANONYMOUS',
      });
      await expect(resolveRegistrant('', concertId, segmentId)).resolves.toEqual({
        kind: 'ANONYMOUS',
      });
    });

    it('resolves a valid token to the player', async () => {
      const registrant = await resolveRegistrant(tokenFor(1), concertId, segmentId);
      expect(registrant).toMatchObject({
        kind: 'PLAYER',
        playerId: playerIds[0],
        fullName: 'Player 1',
        baseAlreadyClaimed: 0,
      });
    });

    /**
     * **The scoping property.** A player of another concert holding a perfectly
     * valid token must not resolve here: their quota, segment and seats belong
     * to the other event, and prefilling them would attach a stranger to this
     * one.
     */
    it('refuses a valid token belonging to another concert', async () => {
      const otherConcert = await createConcert('Other Concert');
      await createPlayers(otherConcert, 1);
      const otherToken = `tok-${otherConcert}-1`;

      // The token really is valid — against its own concert.
      await expect(resolveRegistrant(otherToken, otherConcert, null)).resolves.toMatchObject({
        kind: 'PLAYER',
      });
      // And useless against this one.
      await expect(resolveRegistrant(otherToken, concertId, segmentId)).resolves.toEqual({
        kind: 'UNKNOWN_TOKEN',
      });
    });

    /**
     * A deactivated player has no base entitlement (§7.4), so resolving their
     * token would render rows the engine then refuses to grant.
     */
    it('refuses a deactivated player', async () => {
      await sql`update players set is_active = false where id = ${playerIds[0]}`;
      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toEqual({
        kind: 'UNKNOWN_TOKEN',
      });
    });

    it('refuses a token that is simply wrong', async () => {
      await expect(resolveRegistrant('nope-not-a-token', concertId, segmentId)).resolves.toEqual({
        kind: 'UNKNOWN_TOKEN',
      });
    });

    /**
     * The same guard `load.ts` puts on the slug. Without it a `%00` reaches a
     * parameterised query and Postgres raises `22021` — a 500 with an empty
     * body on a public route.
     */
    it.each(['../../etc/passwd', 'tok with spaces', 'x', '\u0000', "'; drop table players; --"])(
      'refuses %j at the shape guard rather than querying',
      async (bad) => {
        await expect(resolveRegistrant(bad, concertId, segmentId)).resolves.toEqual({
          kind: 'UNKNOWN_TOKEN',
        });
      },
    );
  });

  describe('baseAlreadyClaimed — "remaining", not "quota" (§8.1.1)', () => {
    it('counts confirmed BASE seats the player already holds', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      const outcome = await claimBase(segmentId, registrationId, 2);
      expect(outcome.granted_base).toBe(2);

      const registrant = await resolveRegistrant(tokenFor(1), concertId, segmentId);
      expect(registrant).toMatchObject({ baseAlreadyClaimed: 2 });
    });

    it('does not count another player s seats', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[1],
      });
      await claimBase(segmentId, registrationId, 3);

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
      await expect(resolveRegistrant(tokenFor(2), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 3,
      });
    });

    it('does not count EXTRA seats against the base quota', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await seedAttendees({
        registrationId,
        showId,
        segmentId,
        count: 2,
        allocationType: 'EXTRA',
      });

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
    });

    it('does not count seats that are not confirmed', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await seedAttendees({
        registrationId,
        showId,
        segmentId,
        count: 2,
        allocationType: 'BASE',
        status: 'WAITLIST',
      });

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
    });

    /**
     * **The divergence from the prose, and why the engine wins.**
     *
     * `allocation.md` §7.2 defines `base_claimed(p)` without mentioning the
     * registration's own status; `claim_seats()` additionally excludes seats
     * under a `CANCELLED` registration. Counting the prose version would render
     * one fewer row than the engine will grant to any player who has ever had a
     * registration cancelled — the form silently refusing a seat the player is
     * still owed, with nothing downstream to report it.
     *
     * The assertion is deliberately made against the engine's own behaviour
     * rather than a hand-written number: the claim below proves the player
     * really is owed all three seats again.
     */
    it('stops counting the seats of a cancelled registration', async () => {
      const first = await createRegistration({ showId, segmentId, playerId: playerIds[0] });
      await claimBase(segmentId, first, 3);
      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 3,
      });

      // `registrations_cancel_cascade` carries this down to the attendees.
      await sql`update registrations set status = 'CANCELLED' where id = ${first}`;

      // The form offers three rows again...
      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });

      // ...and the engine really does grant all three, which is what makes that
      // the right number to have offered.
      const second = await createRegistration({ showId, segmentId, playerId: playerIds[0] });
      expect((await claimBase(segmentId, second, 3)).granted_base).toBe(3);
    });

    it('stops counting the seats of a soft-deleted registration', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await claimBase(segmentId, registrationId, 2);
      await sql`update registrations set deleted_at = now() where id = ${registrationId}`;

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
    });

    /**
     * **The two registration-level filters, tested where they are the only
     * thing standing.**
     *
     * In normal operation `registrations_cancel_cascade` carries a cancellation
     * and a soft delete down to the attendees, so `a.status = 'CONFIRMED'` and
     * `a.deleted_at is null` already exclude those rows and the `r.` filters
     * never decide anything. The two tests above therefore pass with both `r.`
     * clauses deleted — verified by deleting them — which makes them fine tests
     * of the *behaviour* and no test at all of the query.
     *
     * The state where the `r.` filters are load-bearing is the race `§7.8`
     * names directly: *"a cancel committing mid-claim leaves `CONFIRMED` seats
     * under a dead registration: the pool excludes them and sells them again,
     * while the door reads `attendees.status` and sees valid ticket holders."*
     * That is what these two reconstruct, by putting the attendees back after
     * the cascade has run. Counting those seats would size the base repeater
     * against seats the engine does not believe in.
     */
    it('ignores CONFIRMED seats stranded under a CANCELLED registration', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await claimBase(segmentId, registrationId, 2);
      await sql`update registrations set status = 'CANCELLED' where id = ${registrationId}`;
      // Undo the cascade, leaving exactly the inconsistent state §7.8 describes.
      // The database refuses to confirm a seat outside `claim_seats()`, so this
      // takes the documented per-transaction opt-out to arrange it.
      await withDirectAttendeeWrites(
        (tx) => tx`
          update attendees set status = 'CONFIRMED' where registration_id = ${registrationId}
        `,
      );

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
    });

    it('ignores live seats stranded under a soft-deleted registration', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await claimBase(segmentId, registrationId, 2);
      await sql`update registrations set deleted_at = now() where id = ${registrationId}`;
      await withDirectAttendeeWrites(
        (tx) => tx`
          update attendees
             set status = 'CONFIRMED', deleted_at = null
           where registration_id = ${registrationId}
        `,
      );

      await expect(resolveRegistrant(tokenFor(1), concertId, segmentId)).resolves.toMatchObject({
        baseAlreadyClaimed: 0,
      });
    });

    /** A feedback form has no segment; there is no base allocation to count. */
    it('counts zero when there is no segment', async () => {
      await expect(resolveRegistrant(tokenFor(1), concertId, null)).resolves.toMatchObject({
        kind: 'PLAYER',
        baseAlreadyClaimed: 0,
      });
    });

    it('returns a number, not a string from the driver', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId: playerIds[0],
      });
      await claimBase(segmentId, registrationId, 1);
      const registrant = await resolveRegistrant(tokenFor(1), concertId, segmentId);
      expect(registrant.kind).toBe('PLAYER');
      if (registrant.kind !== 'PLAYER') return;
      expect(typeof registrant.baseAlreadyClaimed).toBe('number');
      expect(typeof registrant.playerId).toBe('number');
    });
  });
});
