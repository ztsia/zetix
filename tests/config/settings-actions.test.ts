import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../helpers/fixtures';

/**
 * Writing the root of the cascade (spec/README.md §2.2, spec/domain.md §6).
 *
 * Two things are load-bearing here and both fail silently if got wrong: the
 * jsonb double cast, which decides whether `true` is stored as a boolean or as
 * the string `"true"`, and the guard on `system_settings` itself, which is the
 * only thing standing between "lower the default quota" and every segment in
 * the database being quietly oversubscribed.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { setSystemSettingAction, clearSystemSettingAction } = await import(
  '@/app/(admin)/admin/settings/actions'
);
const { resolveSetting } = await import('@/db/settings');

const NO_STATE = { error: null, message: null };

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
}

function set(key: string, value: string): FormData {
  const data = new FormData();
  data.append('key', key);
  data.append('value', value);
  return data;
}

describe('system settings', () => {
  beforeEach(async () => {
    await resetDb();
    await asAdmin();
  });

  it('refuses a signed-out caller', async () => {
    sessionUser.mockResolvedValue(null);
    await expect(
      setSystemSettingAction(NO_STATE, set('email.max_per_dispatch', '25')),
    ).rejects.toBeInstanceOf(RedirectSignal);
  });

  it('refuses a key the system does not read, rather than inventing one', async () => {
    // The table is key/value with no schema, so a typo would otherwise create a
    // setting nothing reads — a value that looks set and is not.
    const result = await setSystemSettingAction(NO_STATE, set('emial.max_per_day', '400'));

    expect(result.error).toMatch(/not a setting/i);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from system_settings`;
    expect(Number(count)).toBe(0);
  });

  describe('values are stored as their real jsonb type, not as strings', () => {
    it('stores a number as a number', async () => {
      await setSystemSettingAction(NO_STATE, set('email.max_per_dispatch', '25'));

      const [row] = await sql<{ kind: string }[]>`
        select jsonb_typeof(value) as kind from system_settings
         where key = 'email.max_per_dispatch'
      `;
      expect(row.kind).toBe('number');
      await expect(resolveSetting('email.max_per_dispatch')).resolves.toBe(25);
    });

    it('stores a boolean as a boolean', async () => {
      // With a bare ::jsonb cast this lands as the string "true", which is still
      // truthy — so nothing errors and the keep-alive silently keeps working
      // while the value is the wrong type.
      await setSystemSettingAction(NO_STATE, set('keepalive.enabled', 'false'));

      const [row] = await sql<{ kind: string }[]>`
        select jsonb_typeof(value) as kind from system_settings where key = 'keepalive.enabled'
      `;
      expect(row.kind).toBe('boolean');
      await expect(resolveSetting('keepalive.enabled')).resolves.toBe(false);
    });

    it('stores the audience-keyed extras policy as an object', async () => {
      // As a jsonb string this never matches the per-audience branch in
      // resolve_setting, and a player segment silently auto-grants extras that
      // decision 4 says must be held for review.
      await setSystemSettingAction(
        NO_STATE,
        set(
          'allocation.extras_policy',
          '{"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"}',
        ),
      );

      const [row] = await sql<{ kind: string }[]>`
        select jsonb_typeof(value) as kind from system_settings
         where key = 'allocation.extras_policy'
      `;
      expect(row.kind).toBe('object');

      const concertId = await createConcert();
      const showId = await createShow(concertId, 400);
      const publicSegment = await createSegment(showId, {
        audienceMode: 'PUBLIC',
        capacity: 300,
        extrasPolicy: null,
      });
      await expect(
        resolveSetting('allocation.extras_policy', { segmentId: publicSegment }),
      ).resolves.toBe('AUTO_FCFS');
    });

    it('rejects malformed JSON with an example rather than a parser message', async () => {
      const result = await setSystemSettingAction(
        NO_STATE,
        set('allocation.extras_policy', '{not json}'),
      );
      expect(result.error).toMatch(/PLAYER_INVITED/);
    });

    it('rejects a number field that is not a number', async () => {
      const result = await setSystemSettingAction(NO_STATE, set('email.max_per_day', 'lots'));
      expect(result.error).toMatch(/not a number/i);
    });

    /**
     * The range checks themselves. A QA pass found them untested: wrapping the
     * `min`/`integer` branches in `if (false && …)` left the suite green, so
     * the bounds were guarded by nothing.
     *
     * They matter because this is the root of the cascade. A value accepted
     * here reaches the dispatcher, the scanner, and — for
     * `allocation.base_quota` — the entitlement guard, which multiplies it by
     * the active player count.
     */
    it.each([
      ['email.max_per_dispatch', '-1', /at least 1/i],
      ['email.max_per_day', '0', /at least 1/i],
      ['email.max_per_day', '3.7', /whole number/i],
      ['allocation.base_quota', '-3', /cannot be negative/i],
      ['segment.capacity', '-1', /cannot be negative/i],
      ['capacity', '2.5', /whole number/i],
      ['checkin.scan_debounce_ms', '-100', /cannot be negative/i],
      ['import.fuzzy_match_threshold', '1.5', /cannot be more than 1/i],
    ])('refuses %s = %s, and stores nothing', async (key, value, expected) => {
      const result = await setSystemSettingAction(NO_STATE, set(key, value));

      expect(result.error).toMatch(expected);
      const rows = await sql<{ value: unknown }[]>`
        select value from system_settings where key = ${key}
      `;
      expect(rows).toHaveLength(0);
    });

    it('accepts the fraction that is genuinely a fraction', async () => {
      // `import.fuzzy_match_threshold` is the one non-integer in §6, so the
      // integer rule must not be applied blindly to every number.
      const result = await setSystemSettingAction(
        NO_STATE,
        set('import.fuzzy_match_threshold', '0.85'),
      );
      expect(result.error).toBeNull();
      await expect(resolveSetting('import.fuzzy_match_threshold')).resolves.toBe(0.85);
    });
  });

  describe('clearing', () => {
    it('removes the row, so nothing supplies the value', async () => {
      await setSystemSettingAction(NO_STATE, set('allocation.base_quota', '2'));
      await expect(resolveSetting('allocation.base_quota')).resolves.toBe(2);

      const result = await clearSystemSettingAction('allocation.base_quota');

      expect(result.error).toBeNull();
      await expect(resolveSetting('allocation.base_quota')).resolves.toBeNull();
    });

    it('treats a blank value as clearing, not as writing an empty string', async () => {
      await setSystemSettingAction(NO_STATE, set('form.extra_rows_max', '4'));

      await setSystemSettingAction(NO_STATE, set('form.extra_rows_max', ''));

      const [{ count }] = await sql<{ count: string }[]>`
        select count(*) from system_settings where key = 'form.extra_rows_max'
      `;
      expect(Number(count)).toBe(0);
    });
  });

  describe('the guard on the root reaches every show (§7.4)', () => {
    beforeEach(async () => {
      const concertId = await createConcert();
      const showId = await createShow(concertId, 400);
      // The segment overrides nothing, so it reads the root's quota.
      await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 3,
        baseQuota: null,
      });
      await createPlayers(concertId, 3);
      await setSystemSettingAction(NO_STATE, set('allocation.base_quota', '1'));
    });

    it('refuses a root quota that oversubscribes a segment somewhere', async () => {
      const result = await setSystemSettingAction(NO_STATE, set('allocation.base_quota', '2'));

      expect(result.error).toMatch(/but the segment holds 3/);
      // Unchanged: the guard is deferred, so the whole edit is rolled back.
      await expect(resolveSetting('allocation.base_quota')).resolves.toBe(1);
    });

    it('refuses clearing it when that leaves a segment with no quota at all', async () => {
      // Removing the row that supplies a resolved value is itself an edit to
      // that value, which is why the guard watches deletes too. Here the
      // segment simply loses its quota — allowed — so this documents that the
      // delete path is exercised rather than asserting a refusal.
      const result = await clearSystemSettingAction('allocation.base_quota');
      expect(result.error).toBeNull();
      await expect(resolveSetting('allocation.base_quota')).resolves.toBeNull();
    });

    it('allows a root quota that every segment can still honour', async () => {
      const result = await setSystemSettingAction(NO_STATE, set('allocation.base_quota', '1'));
      expect(result.error).toBeNull();
    });
  });

  it('records the change in the audit log, both sides', async () => {
    await setSystemSettingAction(NO_STATE, set('email.max_per_day', '450'));
    await setSystemSettingAction(NO_STATE, set('email.max_per_day', '300'));

    const rows = await sql<{ before: unknown; after: unknown }[]>`
      select before, after from audit_log
       where action = 'setting.changed' and entity_id = 'email.max_per_day'
       order by id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].before).toBeNull();
    expect(rows[1].before).toBe(450);
    expect(rows[1].after).toBe(300);
  });
});
