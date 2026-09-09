import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OperatorAuthAdmin } from '@/lib/operators/auth-admin';
import { closeDb, resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';

/**
 * Operator provisioning (spec/admin.md §14.3, spec/checkin.md §12.1).
 *
 * Against a **real Postgres** with a **fake Supabase Auth**, and that split is
 * the point. Creating an operator needs `SUPABASE_SERVICE_ROLE_KEY`, which no
 * cloud session holds (spec/local.md §5b, §7) — so the half that can be proven
 * here is proven here, and what remains is one local pass with real credentials.
 *
 * The fake is the `OperatorAuthAdmin` port and nothing wider. It can be made to
 * fail on demand, which is the only way to reach the orphan-cleanup path — the
 * one place where a half-created operator would otherwise be left behind.
 */
const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

const { createOperator, regenerateAccessCode, setOperatorActive, setShowAssignments } =
  await import('@/lib/operators/provision');
const { OperatorProvisionError } = await import('@/lib/operators/provision');

afterAll(closeDb);

/** Records what the real port would have been asked to do. */
function fakeAuth(overrides: Partial<OperatorAuthAdmin> = {}) {
  const created: Array<{ id: string; email: string; password: string }> = [];
  const deleted: string[] = [];
  const passwords = new Map<string, string>();
  let next = 1;

  const auth: OperatorAuthAdmin = {
    async createUser(email, password) {
      const id = `00000000-0000-4000-8000-0000000001${String(next++).padStart(2, '0')}`;
      created.push({ id, email, password });
      passwords.set(id, password);
      return { id };
    },
    async updatePassword(userId, password) {
      passwords.set(userId, password);
    },
    async deleteUser(userId) {
      deleted.push(userId);
    },
    ...overrides,
  };

  return { auth, created, deleted, passwords };
}

async function arrange() {
  await resetDb();
  await sql`
    insert into app_users (id, email, display_name, role, is_active)
    values (${ADMIN_ID}, 'admin@example.test', 'Committee', 'ADMIN', true)
  `;
  const concertId = await createConcert('Provisioning Concert');
  const showId = await createShow(concertId, 300);
  const otherShowId = await createShow(concertId, 300);
  return { concertId, showId, otherShowId };
}

beforeEach(arrange);

describe('createOperator', () => {
  it('creates the Auth user and the app_users row that gives it a role', async () => {
    const { auth, created } = fakeAuth();

    const operator = await createOperator(
      { displayName: 'Wei Ling', actorId: ADMIN_ID },
      auth,
    );

    expect(operator.email).toBe('wei-ling@operators.invalid');
    expect(created).toHaveLength(1);
    // The code that reaches Supabase is the one handed to the admin — not a
    // prettified copy. An operator types exactly what was on screen.
    expect(created[0]!.password).toBe(operator.accessCode);

    const rows = await sql`
      select id, email, display_name, role, is_active from app_users where id = ${operator.userId}
    `;
    expect(rows[0]).toMatchObject({
      email: 'wei-ling@operators.invalid',
      display_name: 'Wei Ling',
      role: 'OPERATOR',
      is_active: true,
    });
  });

  it('derives the address with operatorEmail(), so the login form agrees with it', async () => {
    const { auth } = fakeAuth();
    // Diacritics and case are exactly where a second slug implementation drifts,
    // and the failure is an usher who cannot sign in (modules.md §5.2.1).
    const operator = await createOperator(
      { displayName: 'Sïti Nur Aisyah', actorId: ADMIN_ID },
      auth,
    );
    const { operatorEmail } = await import('@/lib/auth/operator-slug');
    expect(operator.email).toBe(operatorEmail('Siti Nur Aisyah'));
  });

  it('refuses a second operator whose name collides, naming the one it clashes with', async () => {
    const { auth } = fakeAuth();
    await createOperator({ displayName: 'Ali', actorId: ADMIN_ID }, auth);

    await expect(
      createOperator({ displayName: 'ali', actorId: ADMIN_ID }, auth),
    ).rejects.toBeInstanceOf(OperatorProvisionError);

    await expect(
      createOperator({ displayName: 'Ali', actorId: ADMIN_ID }, auth),
    ).rejects.toThrow(/"Ali"/);
  });

  it('checks for the clash before touching Supabase, so no orphan Auth user is made', async () => {
    const { auth, created } = fakeAuth();
    await createOperator({ displayName: 'Ali', actorId: ADMIN_ID }, auth);
    expect(created).toHaveLength(1);

    await expect(
      createOperator({ displayName: 'Ali', actorId: ADMIN_ID }, auth),
    ).rejects.toThrow();

    expect(created).toHaveLength(1);
  });

  it('refuses a name with nothing to build an address from', async () => {
    const { auth, created } = fakeAuth();
    await expect(
      createOperator({ displayName: '!!!', actorId: ADMIN_ID }, auth),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
    expect(created).toHaveLength(0);
  });

  it('deletes the Auth user when the database write fails afterwards', async () => {
    // An Auth user with no `app_users` row authenticates and resolves to nobody:
    // the usher sees a login that appears to work and then does nothing.
    //
    // The failure is provoked with a **real** primary-key collision rather than
    // a stubbed insert. `app_users.id` is the Auth id, so an Auth server that
    // hands back an id already in the table is exactly the shape of the race
    // this cleanup exists for — and asserting against Postgres' own rejection
    // means the test still holds if the insert is ever rewritten.
    const takenId = '00000000-0000-4000-8000-0000000000bb';
    await sql`
      insert into app_users (id, email, display_name, role, is_active)
      values (${takenId}, 'taken@example.test', 'Taken', 'OPERATOR', true)
    `;

    const { auth, deleted } = fakeAuth({
      async createUser() {
        return { id: takenId };
      },
    });

    await expect(
      createOperator({ displayName: 'Mei', actorId: ADMIN_ID }, auth),
    ).rejects.toThrow();

    expect(deleted).toEqual([takenId]);

    // Only the pre-existing row survives: nothing half-created was left behind.
    const rows = await sql`select email from app_users where role = 'OPERATOR'`;
    expect(rows.map((r) => r.email)).toEqual(['taken@example.test']);
  });

  it('never writes the access code to the audit log', async () => {
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    const rows = await sql`select * from audit_log where action = 'operator.created'`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(operator.accessCode);
  });
});

describe('regenerateAccessCode', () => {
  it('issues a different code and pushes it to Auth', async () => {
    const { auth, passwords } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    const rotated = await regenerateAccessCode(
      { userId: operator.userId, actorId: ADMIN_ID },
      auth,
    );

    expect(rotated.accessCode).not.toBe(operator.accessCode);
    expect(passwords.get(operator.userId)).toBe(rotated.accessCode);
  });

  it('refuses to touch the shared ADMIN account', async () => {
    const { auth } = fakeAuth();
    // Rotating the committee's single shared code from the operator screen would
    // lock them out of their own console, with no second admin to undo it.
    await expect(
      regenerateAccessCode({ userId: ADMIN_ID, actorId: ADMIN_ID }, auth),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
  });
});

describe('setOperatorActive', () => {
  it('deactivates, which is what getSessionUser() reads to cut access', async () => {
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    await setOperatorActive({ userId: operator.userId, isActive: false, actorId: ADMIN_ID });

    const rows = await sql`select is_active from app_users where id = ${operator.userId}`;
    expect(rows[0]!.is_active).toBe(false);
  });

  it('restores an operator, and logs both directions', async () => {
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    await setOperatorActive({ userId: operator.userId, isActive: false, actorId: ADMIN_ID });
    await setOperatorActive({ userId: operator.userId, isActive: true, actorId: ADMIN_ID });

    const rows = await sql`select is_active from app_users where id = ${operator.userId}`;
    expect(rows[0]!.is_active).toBe(true);

    const log = await sql`select action from audit_log where action like 'operator.%activated'`;
    expect(log.map((r) => r.action).sort()).toEqual([
      'operator.deactivated',
      'operator.reactivated',
    ]);
  });

  it('refuses to deactivate the shared ADMIN account', async () => {
    await expect(
      setOperatorActive({ userId: ADMIN_ID, isActive: false, actorId: ADMIN_ID }),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
  });
});

describe('setShowAssignments', () => {
  it('assigns and revokes to match the grid that was saved', async () => {
    const { concertId, showId, otherShowId } = await arrange();
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    await setShowAssignments({
      userId: operator.userId,
      concertId,
      showIds: [showId, otherShowId],
      actorId: ADMIN_ID,
    });
    let rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows.map((r) => Number(r.show_id)).sort()).toEqual([showId, otherShowId].sort());

    await setShowAssignments({
      userId: operator.userId,
      concertId,
      showIds: [otherShowId],
      actorId: ADMIN_ID,
    });
    rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows.map((r) => Number(r.show_id))).toEqual([otherShowId]);
  });

  it('clearing every box removes every assignment in this concert', async () => {
    const { concertId, showId } = await arrange();
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    await setShowAssignments({
      userId: operator.userId,
      concertId,
      showIds: [showId],
      actorId: ADMIN_ID,
    });
    await setShowAssignments({
      userId: operator.userId,
      concertId,
      showIds: [],
      actorId: ADMIN_ID,
    });

    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('leaves another concert\'s assignments alone', async () => {
    const { concertId, showId } = await arrange();
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    // The grid can only show one concert's shows, so a "delete all, insert the
    // ticked ones" save would silently strip every other concert this usher
    // works — and nothing on screen would say so.
    const otherConcertId = await createConcert('Another Concert');
    const foreignShowId = await createShow(otherConcertId, 200);
    await setShowAssignments({
      userId: operator.userId,
      concertId: otherConcertId,
      showIds: [foreignShowId],
      actorId: ADMIN_ID,
    });

    await setShowAssignments({
      userId: operator.userId,
      concertId,
      showIds: [showId],
      actorId: ADMIN_ID,
    });

    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows.map((r) => Number(r.show_id)).sort()).toEqual([showId, foreignShowId].sort());
  });

  it('refuses a show belonging to a different concert', async () => {
    const { concertId } = await arrange();
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    const otherConcertId = await createConcert('Another Concert');
    const foreignShowId = await createShow(otherConcertId, 200);

    // A hand-edited form must not be able to grant a roster the admin never saw.
    await expect(
      setShowAssignments({
        userId: operator.userId,
        concertId,
        showIds: [foreignShowId],
        actorId: ADMIN_ID,
      }),
    ).rejects.toBeInstanceOf(OperatorProvisionError);

    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('is idempotent, so re-saving an unchanged grid is harmless', async () => {
    const { concertId, showId } = await arrange();
    const { auth } = fakeAuth();
    const operator = await createOperator({ displayName: 'Wei', actorId: ADMIN_ID }, auth);

    const args = {
      userId: operator.userId,
      concertId,
      showIds: [showId],
      actorId: ADMIN_ID,
    };
    await setShowAssignments(args);
    await setShowAssignments(args);

    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${operator.userId}
    `;
    expect(rows).toHaveLength(1);
  });

  it('refuses to assign shows to the shared ADMIN account', async () => {
    const { concertId, showId } = await arrange();
    await expect(
      setShowAssignments({
        userId: ADMIN_ID,
        concertId,
        showIds: [showId],
        actorId: ADMIN_ID,
      }),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
  });
});
