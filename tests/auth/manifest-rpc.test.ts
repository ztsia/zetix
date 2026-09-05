import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  createPlayers,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * `manifest_for_show()` — the second layer decision 20 requires.
 *
 * Decision 20 wants the show-scope check "in the handler and again by RLS — the
 * handler is the contract, RLS is what survives a mistake in the handler."
 * Module `F2` built the handler half (`canAccessShow()`). This is the other
 * half, and it is a `security definer` function reached through PostgREST
 * rather than a policy on `attendees`, for the reason recorded as decision 20b:
 * a policy on a base table is only reachable if `authenticated` has been
 * *granted* that table, and that grant publishes the roster at
 * `/rest/v1/attendees` to anyone holding the publishable key — which ships in
 * the browser bundle by design. `execute` on one function opens no such door.
 *
 * So this file has to prove two different things, and the second is the one
 * that is easy to forget:
 *
 *   1. the function refuses a show the caller is not rostered on;
 *   2. **no table grant leaked in beside the function grant.** A perfect scope
 *      check on the function is worth nothing if `attendees` became readable
 *      next to it.
 *
 * The caller is resolved from the JWT `sub` claim, which is what PostgREST sets
 * and what `auth.uid()` reads. Setting `request.jwt.claims` directly is how the
 * same code path is exercised against a local Postgres 16 that has no
 * PostgREST and no `auth` schema (spec/platform.md §16.4). `local.md` §5a holds
 * the two checks that can only be made against real Supabase.
 */

type ManifestRow = {
  qr_token_sha256: string | null;
  ticket_code: string | null;
  name: string;
  player_name: string | null;
  status: string;
  registration_id: string | number;
  party_size: number;
};

/** Calls the function as `userId` would arrive through PostgREST. */
async function manifestAs(
  userId: string | null,
  showId: number,
): Promise<ManifestRow[]> {
  return sql.begin(async (tx) => {
    // `set local` so the claim dies with the transaction and cannot leak into
    // the next assertion through a pooled connection.
    const claims = userId === null ? '' : JSON.stringify({ sub: userId });
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return tx<ManifestRow[]>`select * from manifest_for_show(${showId})`;
  }) as unknown as Promise<ManifestRow[]>;
}

async function createUser(
  role: 'ADMIN' | 'OPERATOR',
  opts: { isActive?: boolean; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role, is_active, deleted_at)
    values (
      ${id}::uuid, ${`${role.toLowerCase()}-${id}@example.test`}, ${role},
      ${role}::user_role, ${opts.isActive ?? true},
      ${opts.deleted ? sql`now()` : null}
    )
  `;
  return id;
}

async function assign(userId: string, showId: number): Promise<void> {
  await sql`
    insert into operator_show_assignments (user_id, show_id)
    values (${userId}::uuid, ${showId})
  `;
}

/** One attendee with a real token, so the hashing assertion has something to hash. */
async function seedAttendee(opts: {
  registrationId: number;
  showId: number;
  segmentId: number;
  fullName: string;
  qrToken: string | null;
  ticketCode: string | null;
  status?: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  deleted?: boolean;
}): Promise<void> {
  await withDirectAttendeeWrites(async (tx) => {
    await tx`
      insert into attendees (
        registration_id, show_id, segment_id, full_name, name_source,
        allocation_type, status, qr_token, ticket_code, deleted_at
      ) values (
        ${opts.registrationId}, ${opts.showId}, ${opts.segmentId},
        ${opts.fullName}, 'PROVIDED', 'BASE', ${opts.status ?? 'CONFIRMED'},
        ${opts.qrToken}, ${opts.ticketCode},
        ${opts.deleted ? sql`now()` : null}
      )
    `;
  });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('manifest_for_show()', () => {
  let assignedShow: number;
  let otherShow: number;
  let assignedSegment: number;
  let otherSegment: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();

    assignedShow = await createShow(concertId, 100);
    assignedSegment = await createSegment(assignedShow, {
      audienceMode: 'PUBLIC',
      capacity: 100,
    });

    otherShow = await createShow(concertId, 100);
    otherSegment = await createSegment(otherShow, {
      audienceMode: 'PUBLIC',
      capacity: 100,
    });

    for (const [showId, segmentId, who] of [
      [assignedShow, assignedSegment, 'Assigned Guest'],
      [otherShow, otherSegment, 'Other Guest'],
    ] as const) {
      const registrationId = await createRegistration({ showId, segmentId });
      await seedAttendee({
        registrationId,
        showId,
        segmentId,
        fullName: who,
        qrToken: `tok-${who.toLowerCase().replace(/\s+/g, '-')}`,
        ticketCode: `TC-${who.toUpperCase().replace(/\s+/g, '-')}`,
      });
    }
  });

  describe('scope — the check that must survive a mistake in the handler', () => {
    it('returns the roster for a show the operator is rostered on', async () => {
      const id = await createUser('OPERATOR');
      await assign(id, assignedShow);

      const rows = await manifestAs(id, assignedShow);
      expect(rows.map((r) => r.name)).toEqual(['Assigned Guest']);
    });

    it('returns nothing for a show the operator is not rostered on', async () => {
      // The failing test the handoff asked for first: assigned to show 1,
      // asking for show 2, with the handler bypassed entirely.
      const id = await createUser('OPERATOR');
      await assign(id, assignedShow);

      expect(await manifestAs(id, otherShow)).toEqual([]);
    });

    it('returns nothing for an operator with no assignments at all', async () => {
      // Provisioned but not yet rostered — correct, not an error state.
      const id = await createUser('OPERATOR');
      expect(await manifestAs(id, assignedShow)).toEqual([]);
    });

    it('returns nothing for an unauthenticated caller', async () => {
      // No PostgREST means no claim, and a null subject must resolve to nobody
      // rather than to everybody.
      expect(await manifestAs(null, assignedShow)).toEqual([]);
    });

    it('returns nothing for a JWT subject that is not an app_user', async () => {
      // A real Supabase Auth user who was never provisioned into app_users.
      expect(await manifestAs(randomUUID(), assignedShow)).toEqual([]);
    });

    it('returns nothing for a deactivated operator', async () => {
      // Revocation is `is_active = false`; it must bite here and not only in
      // the handler, or a sacked usher keeps the roster.
      const id = await createUser('OPERATOR', { isActive: false });
      await assign(id, assignedShow);
      expect(await manifestAs(id, assignedShow)).toEqual([]);
    });

    it('returns nothing for a soft-deleted operator', async () => {
      const id = await createUser('OPERATOR', { deleted: true });
      await assign(id, assignedShow);
      expect(await manifestAs(id, assignedShow)).toEqual([]);
    });

    it('returns nothing for a deactivated ADMIN', async () => {
      // The shared committee account is one account (decision 19), so
      // deactivating it is the only revocation there is.
      const id = await createUser('ADMIN', { isActive: false });
      expect(await manifestAs(id, assignedShow)).toEqual([]);
    });

    it('lets an ADMIN read any show, with no assignment row', async () => {
      const id = await createUser('ADMIN');
      expect((await manifestAs(id, assignedShow)).map((r) => r.name)).toEqual([
        'Assigned Guest',
      ]);
      expect((await manifestAs(id, otherShow)).map((r) => r.name)).toEqual([
        'Other Guest',
      ]);
    });

    it('is indistinguishable between "not yours" and "not there"', async () => {
      // modules.md §5.2.1: probing ids must not tell the two apart. Zero rows
      // for both is what makes that true in the database rather than in a
      // handler's choice of status code.
      const id = await createUser('OPERATOR');
      await assign(id, assignedShow);
      expect(await manifestAs(id, otherShow)).toEqual([]);
      expect(await manifestAs(id, 987654)).toEqual([]);
    });
  });

  describe('shape — the seven fields of spec/checkin.md §12.3', () => {
    it('hashes the token and never returns the token itself', async () => {
      // The manifest lands in IndexedDB on an usher's phone. A raw token there
      // is a usable ticket for anyone who picks the phone up.
      const id = await createUser('OPERATOR');
      await assign(id, assignedShow);

      const [row] = await manifestAs(id, assignedShow);
      expect(row.qr_token_sha256).toBe(sha256('tok-assigned-guest'));
      expect(JSON.stringify(row)).not.toContain('tok-assigned-guest');
    });

    it('returns exactly the seven specified fields', async () => {
      const id = await createUser('ADMIN');
      const [row] = await manifestAs(id, assignedShow);
      expect(Object.keys(row).sort()).toEqual(
        [
          'name',
          'party_size',
          'player_name',
          'qr_token_sha256',
          'registration_id',
          'status',
          'ticket_code',
        ].sort(),
      );
    });

    it('carries party size and the inviting player, for the offline party control', async () => {
      // §12.1's "Admit remaining 3" has to work with no network, so both come
      // from the manifest rather than from a lookup at the door.
      const concertId = await createConcert('Party Concert');
      const showId = await createShow(concertId, 100);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 100,
        baseQuota: 1,
      });
      const [playerId] = await createPlayers(concertId, 1);
      const registrationId = await createRegistration({
        showId,
        segmentId,
        playerId,
      });
      for (const n of [1, 2, 3]) {
        await seedAttendee({
          registrationId,
          showId,
          segmentId,
          fullName: `Party Member ${n}`,
          qrToken: `party-tok-${n}`,
          ticketCode: `PARTY-${n}`,
        });
      }

      const id = await createUser('ADMIN');
      const rows = await manifestAs(id, showId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.party_size).toBe(3);
        expect(row.player_name).toBe('Player 1');
        expect(Number(row.registration_id)).toBe(registrationId);
      }
    });

    it('leaves player_name null for a public registration', async () => {
      // §12.1 shows the inviting player on the admitted state. A public party
      // has none, and an empty string or a placeholder there would print as a
      // name at the door.
      const id = await createUser('ADMIN');
      const [row] = await manifestAs(id, assignedShow);
      expect(row.player_name).toBeNull();
    });

    it('still returns a cancelled attendee, so the door can say "refer to desk"', async () => {
      // spec/allocation.md §7.9: a cancelled ticket must read as cancelled, not
      // as "invalid ticket". Omitting it from the manifest makes the door lie.
      const registrationId = await createRegistration({
        showId: assignedShow,
        segmentId: assignedSegment,
        status: 'CANCELLED',
      });
      await seedAttendee({
        registrationId,
        showId: assignedShow,
        segmentId: assignedSegment,
        fullName: 'Cancelled Guest',
        qrToken: 'tok-cancelled',
        ticketCode: 'TC-CANCELLED',
        status: 'CANCELLED',
      });

      const id = await createUser('ADMIN');
      const rows = await manifestAs(id, assignedShow);
      const cancelled = rows.find((r) => r.name === 'Cancelled Guest');
      expect(cancelled?.status).toBe('CANCELLED');
    });

    it('omits a soft-deleted attendee', async () => {
      const registrationId = await createRegistration({
        showId: assignedShow,
        segmentId: assignedSegment,
      });
      await seedAttendee({
        registrationId,
        showId: assignedShow,
        segmentId: assignedSegment,
        fullName: 'Deleted Guest',
        qrToken: 'tok-deleted',
        ticketCode: 'TC-DELETED',
        deleted: true,
      });

      const id = await createUser('ADMIN');
      const rows = await manifestAs(id, assignedShow);
      expect(rows.map((r) => r.name)).not.toContain('Deleted Guest');
    });
  });

  describe('jwt_sub() — a malformed claim is nobody, never an error', () => {
    // A caller who can make this throw gets a 500 out of the manifest endpoint,
    // and a 500 that only fires for some inputs is a louder oracle than an
    // empty list. Every one of these arrives from outside.
    const malformed = [
      ['not json at all', 'not json'],
      ['an empty object', '{}'],
      ['a sub that is not a uuid', '{"sub":"not-a-uuid"}'],
      ['a json array', '[]'],
      ['a bare json string', '"a string"'],
      ['a null sub', '{"sub":null}'],
      ['an empty sub', '{"sub":""}'],
      ['a numeric sub', '{"sub":42}'],
    ] as const;

    for (const [label, claims] of malformed) {
      it(`resolves ${label} to null without throwing`, async () => {
        const rows = await sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${claims}, true)`;
          return tx<{ sub: string | null }[]>`select jwt_sub() as sub`;
        });
        expect(rows[0].sub).toBeNull();
      });

      it(`returns zero rows rather than an error for ${label}`, async () => {
        const rows = await sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${claims}, true)`;
          return tx`select * from manifest_for_show(${assignedShow})`;
        });
        expect(rows).toEqual([]);
      });
    }
  });

  describe('the door that must stay shut', () => {
    it('is security definer with a pinned search_path', async () => {
      // Without `search_path` pinned, a caller who can create objects can shadow
      // a table name and have the definer run their version as the owner.
      const [fn] = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
        select prosecdef, proconfig
        from pg_proc
        where proname = 'manifest_for_show'
          and pronamespace = 'public'::regnamespace
      `;
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig ?? []).toContain('search_path=public, pg_temp');
    });

    it('grants execute to authenticated and to nobody else', async () => {
      const rows = await sql<{ grantee: string }[]>`
        select grantee
        from information_schema.role_routine_grants
        where routine_name = 'manifest_for_show'
          and routine_schema = 'public'
          and privilege_type = 'EXECUTE'
          and grantee <> current_user
          and grantee <> 'postgres'
      `;
      expect(rows.map((r) => r.grantee).sort()).toEqual(['authenticated']);
    });

    it('denies by default on the roster tables', async () => {
      // Belt to the grants' braces (decision 20b). RLS with no policies denies
      // every non-owner role outright, so if a table grant ever leaks in, the
      // door it opens is already bolted. The owner bypasses it, which is why
      // claim_seats() and the allocation triggers are unaffected.
      const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
        select relname, relrowsecurity
        from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in (
            'attendees', 'registrations', 'check_ins', 'app_users',
            'operator_show_assignments', 'players', 'email_outbox'
          )
      `;
      expect(rows).toHaveLength(7);
      expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
    });

    it('has no policies, because the deny is the point', async () => {
      // A policy here would be the mechanism decision 20b rejected. If one
      // appears, someone has reopened that question in code rather than in
      // decisions.md.
      const rows = await sql<{ tablename: string; policyname: string }[]>`
        select tablename, policyname from pg_policies where schemaname = 'public'
      `;
      expect(rows).toEqual([]);
    });

    it('still denies a leaked table grant, which is what the RLS is for', async () => {
      // The claim in decision 20b is not "no grant exists" — it is that a grant
      // appearing later opens a door that is already bolted. Untested, that is
      // an assertion about a `pg_class` flag; tested, it is the behaviour.
      try {
        const rows = await sql.begin(async (tx) => {
          // `usage` on the schema as well, because Supabase already grants that
          // to `authenticated` and a local Postgres does not. Without it the
          // select fails with "relation does not exist" — a stronger refusal
          // than the one under test, which would let this pass for the wrong
          // reason.
          await tx`grant usage on schema public to authenticated`;
          await tx`grant select on attendees to authenticated`;
          await tx`set local role authenticated`;
          return tx<{ n: number }[]>`select count(*)::int as n from attendees`;
        });
        expect(rows[0].n).toBe(0);

        // And the same select as the owner still sees them, so the zero above is
        // RLS refusing rather than an empty table.
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from attendees`;
        expect(n).toBeGreaterThan(0);
      } finally {
        // `sql.begin` commits on success, so the grant would otherwise outlive
        // this test — and the very next one asserts there are none.
        await sql`revoke select on attendees from authenticated`;
        await sql`revoke usage on schema public from authenticated`;
      }
    });

    it('leaks no table grant beside the function grant', async () => {
      // The regression this whole mechanism exists to avoid. A `grant select` on
      // any of these publishes it at `/rest/v1/<table>` to anyone holding the
      // publishable key. If this test ever goes red, read the diff, not the test.
      const rows = await sql<{ table_name: string; grantee: string; privilege_type: string }[]>`
        select table_name, grantee, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public'
          and grantee in ('authenticated', 'anon', 'PUBLIC')
      `;
      expect(rows).toEqual([]);
    });
  });
});
