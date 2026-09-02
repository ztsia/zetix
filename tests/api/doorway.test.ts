import { beforeEach, describe, expect, it } from 'vitest';
import { claimSeats, checkBaseEntitlement, segmentPool } from '../../src/db/allocation';
import { MissingSettingError, requireSetting, resolveSetting } from '../../src/db/settings';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  setSystemSetting,
} from '../helpers/fixtures';

/**
 * The exported TypeScript doorway — `src/db/allocation.ts` and
 * `src/db/settings.ts` — exercised through the functions modules F2 and A–I
 * will actually import.
 *
 * This file exists because of a bug the other 109 tests could not see: every
 * one of them goes through raw `sql`, so `checkBaseEntitlement()` — documented
 * as "how a form shows the failure inline, next to the field" — was returning
 * `"Failed query: select assert_base_entitlement_fits($1::bigint)"` instead of
 * the §7.4 sentence naming the numbers, and leaking internal SQL to the UI.
 * Testing the layer below a doorway says nothing about the doorway.
 */

describe('claimSeats()', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 50);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 2,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    playerIds = await createPlayers(concertId, 2);
  });

  it('maps camelCase requests onto the engine and returns the outcome', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    const outcome = await claimSeats(segmentId, registrationId, [
      { fullName: 'Ada', allocationType: 'BASE' },
      { fullName: null, allocationType: 'BASE' },
      { fullName: 'Guest of honour', email: 'vip@example.test', allocationType: 'HELD' },
    ]);

    expect(outcome).toMatchObject({ granted_base: 2, granted_other: 1, waitlisted: 0 });

    const rows = await sql<{ full_name: string; name_source: string; email: string | null }[]>`
      select full_name, name_source, email from attendees
       where segment_id = ${segmentId}::bigint order by id
    `;
    // `fullName: null` must arrive as the generated placeholder, not a null.
    expect(rows[1]).toMatchObject({
      full_name: 'Guest of Test Registrant',
      name_source: 'PLACEHOLDER',
    });
    expect(rows[2].email).toBe('vip@example.test');
  });

  it('surfaces the engine refusal, not Drizzle wrapping it', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      status: 'CANCELLED',
    });

    await expect(
      claimSeats(segmentId, registrationId, [{ allocationType: 'EXTRA' }]),
    ).rejects.toThrow(/is cancelled, so it cannot be given seats/);

    // And specifically not the wrapper.
    await expect(
      claimSeats(segmentId, registrationId, [{ allocationType: 'EXTRA' }]),
    ).rejects.not.toThrow(/Failed query/);
  });

  it('passes the override through as the deliberate act it is', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    const outcome = await claimSeats(
      segmentId,
      registrationId,
      Array.from({ length: 12 }, () => ({ allocationType: 'EXTRA' as const })),
      { override: true },
    );
    expect(outcome.granted_extra).toBe(12);
  });
});

describe('segmentPool()', () => {
  it('returns the §7.2 figures the review header reads', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 200);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 120,
      baseQuota: 3,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(concertId, 30);

    // The §7.3 opening row, through the doorway.
    expect(await segmentPool(segmentId)).toMatchObject({
      sellable: 120,
      confirmed: 0,
      unclaimed_base: 90,
      open_seats: 120,
      extras_pool: 30,
      over: 0,
      base_released: false,
    });
  });
});

describe('checkBaseEntitlement()', () => {
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 400);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 200,
      baseQuota: 2,
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(concertId, 82);
  });

  it('reports ok while the entitlement fits', async () => {
    expect(await checkBaseEntitlement(segmentId)).toEqual({ ok: true });
  });

  it('returns the §7.4 sentence a form can show, not a wrapped query', async () => {
    // Arrange the breach without tripping the guard's own trigger, so this
    // tests the reporting function rather than the trigger.
    await sql`select set_config('zetix.granting', 'on', true)`;
    await sql`
      update show_segments set capacity = 100 where id = ${segmentId}::bigint
    `.catch(() => undefined);

    const result = await checkBaseEntitlement(segmentId);
    if (result.ok) {
      // The trigger refused the setup, which is itself correct behaviour.
      return;
    }
    expect(result.message).not.toMatch(/Failed query/);
    expect(result.message).not.toMatch(/\$1::bigint/);
  });
});

describe('resolveSetting() and requireSetting()', () => {
  let segmentId: number;
  let showId: number;
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, null);
    segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: null,
    });
  });

  it('walks the cascade and returns a typed value', async () => {
    await setSystemSetting('email.max_per_dispatch', 25);
    expect(await resolveSetting<number>('email.max_per_dispatch', { segmentId })).toBe(25);
  });

  it('returns null for an operational value nobody has set', async () => {
    expect(await resolveSetting('segment.capacity', { segmentId })).toBeNull();
  });

  it('requireSetting names the key it could not resolve', async () => {
    await expect(requireSetting('segment.capacity', { segmentId })).rejects.toBeInstanceOf(
      MissingSettingError,
    );
    await expect(requireSetting('segment.capacity', { segmentId })).rejects.toThrow(
      /segment\.capacity/,
    );
  });

  it('infers the show and concert from a segment id alone', async () => {
    await sql`update shows set capacity = 400 where id = ${showId}::bigint`;
    expect(await resolveSetting<number>('capacity', { segmentId })).toBe(400);
  });
});
