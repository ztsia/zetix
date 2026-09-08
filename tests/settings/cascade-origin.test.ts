import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  json,
  setSystemSetting,
} from '../helpers/fixtures';
import { resolveWithOrigin } from '@/db/cascade-origin';

/**
 * `resolveWithOrigin` — which level of the cascade supplies a value
 * (spec/README.md §2.2, spec/domain.md §6).
 *
 * The value itself is `resolve_setting()`'s job and is tested in
 * `cascade.test.ts`. What is tested here is the *origin*, because that is the
 * part the admin UI renders and the part that is easy to get quietly wrong: a
 * capacity field showing an inherited number as though this segment set it is
 * how an admin edits the wrong level.
 */
describe('resolveWithOrigin — spec/README.md §2.2', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 400);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: null,
      extrasPolicy: null,
    });
  });

  it('reports "unset" when no level supplies a value', async () => {
    // Operational values carry no install-time seed on purpose (§6): a missing
    // one is a validation error at save time, never a silent fallback. "unset"
    // is what the UI must be able to say.
    const resolved = await resolveWithOrigin(['allocation.base_quota'], {
      segmentId,
      showId,
      concertId,
    });

    expect(resolved['allocation.base_quota']).toEqual({
      key: 'allocation.base_quota',
      value: null,
      origin: 'unset',
    });
  });

  it('attributes a value to the system root', async () => {
    await setSystemSetting('allocation.base_quota', 2);

    const resolved = await resolveWithOrigin(['allocation.base_quota'], {
      segmentId,
      showId,
      concertId,
    });

    expect(resolved['allocation.base_quota'].value).toBe(2);
    expect(resolved['allocation.base_quota'].origin).toBe('system');
  });

  it('attributes a value to the concert when its defaults bag overrides the root', async () => {
    await setSystemSetting('allocation.base_quota', 2);
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 3 })}::jsonb
       where id = ${concertId}::bigint
    `;

    const resolved = await resolveWithOrigin(['allocation.base_quota'], {
      segmentId,
      showId,
      concertId,
    });

    expect(resolved['allocation.base_quota'].value).toBe(3);
    expect(resolved['allocation.base_quota'].origin).toBe('concert');
  });

  it('attributes a value to the show when its defaults bag overrides the concert', async () => {
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 3 })}::jsonb
       where id = ${concertId}::bigint
    `;
    await sql`
      update shows set defaults = ${json({ 'allocation.base_quota': 4 })}::jsonb
       where id = ${showId}::bigint
    `;

    const resolved = await resolveWithOrigin(['allocation.base_quota'], {
      segmentId,
      showId,
      concertId,
    });

    expect(resolved['allocation.base_quota'].value).toBe(4);
    expect(resolved['allocation.base_quota'].origin).toBe('show');
  });

  it('attributes a value to the segment, the narrowest level', async () => {
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 3 })}::jsonb
       where id = ${concertId}::bigint
    `;
    await sql`update show_segments set base_quota = 1 where id = ${segmentId}::bigint`;

    const resolved = await resolveWithOrigin(['allocation.base_quota'], {
      segmentId,
      showId,
      concertId,
    });

    expect(resolved['allocation.base_quota'].value).toBe(1);
    expect(resolved['allocation.base_quota'].origin).toBe('segment');
  });

  it("reads the show's typed capacity column, not just its defaults bag", async () => {
    const resolved = await resolveWithOrigin(['capacity'], { segmentId, showId, concertId });

    expect(resolved['capacity'].value).toBe(400);
    expect(resolved['capacity'].origin).toBe('show');
  });

  it('resolves several keys in one call, each with its own origin', async () => {
    await setSystemSetting('email.max_per_dispatch', 25);
    await sql`update show_segments set capacity = 100 where id = ${segmentId}::bigint`;

    const resolved = await resolveWithOrigin(
      ['segment.capacity', 'capacity', 'email.max_per_dispatch', 'allocation.base_quota'],
      { segmentId, showId, concertId },
    );

    expect(resolved['segment.capacity']).toMatchObject({ value: 100, origin: 'segment' });
    expect(resolved['capacity']).toMatchObject({ value: 400, origin: 'show' });
    expect(resolved['email.max_per_dispatch']).toMatchObject({ value: 25, origin: 'system' });
    expect(resolved['allocation.base_quota']).toMatchObject({ origin: 'unset' });
  });

  it('resolves the audience-keyed extras policy against the segment that asked', async () => {
    // `allocation.extras_policy` is stored at the root as an object keyed by
    // audience mode (decision 4), so the root's answer depends on which segment
    // is asking. The origin must still read as "system" — the segment overrides
    // nothing, it only selects.
    await setSystemSetting('allocation.extras_policy', {
      PLAYER_INVITED: 'REVIEW',
      PUBLIC: 'AUTO_FCFS',
    });
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: null,
      extrasPolicy: null,
    });

    const player = await resolveWithOrigin(['allocation.extras_policy'], {
      segmentId,
      showId,
      concertId,
    });
    const pub = await resolveWithOrigin(['allocation.extras_policy'], {
      segmentId: publicSegment,
      showId,
      concertId,
    });

    expect(player['allocation.extras_policy'].value).toBe('REVIEW');
    expect(pub['allocation.extras_policy'].value).toBe('AUTO_FCFS');
  });

  it('returns nothing for no keys, without touching the database', async () => {
    await expect(resolveWithOrigin([], { segmentId })).resolves.toEqual({});
  });
});
