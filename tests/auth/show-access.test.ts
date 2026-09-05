import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';
import { canAccessShow } from '../../src/lib/auth/show-access';

/**
 * Which shows an operator may reach (decision 20, spec/checkin.md §12.3, §14.3).
 *
 * The manifest behind a show is the full attendee roster, so this is the check
 * that stands between one usher and the whole audience list. It is tested
 * against a **real** Postgres with real assignment rows rather than a mock,
 * because the thing that can break is the query, not the branch around it.
 *
 * An independent QA pass deleted this check from the scanner route and the whole
 * suite stayed green. That is the gap these close.
 */
async function createUser(role: 'ADMIN' | 'OPERATOR'): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`${role.toLowerCase()}-${id}@example.test`}, ${role}, ${role}::user_role)
  `;
  return id;
}

async function assign(userId: string, showId: number): Promise<void> {
  await sql`
    insert into operator_show_assignments (user_id, show_id)
    values (${userId}::uuid, ${showId})
  `;
}

describe('canAccessShow', () => {
  let assignedShow: number;
  let otherShow: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    assignedShow = await createShow(concertId, 100);
    otherShow = await createShow(concertId, 100);
  });

  it('lets an operator into a show they are rostered on', async () => {
    const id = await createUser('OPERATOR');
    await assign(id, assignedShow);
    expect(await canAccessShow({ id, role: 'OPERATOR' }, assignedShow)).toBe(true);
  });

  it('refuses an operator a show they are not rostered on', async () => {
    const id = await createUser('OPERATOR');
    await assign(id, assignedShow);
    expect(await canAccessShow({ id, role: 'OPERATOR' }, otherShow)).toBe(false);
  });

  it('refuses an operator with no assignments at all', async () => {
    // Provisioned but not rostered — correct behaviour, not an error state.
    const id = await createUser('OPERATOR');
    expect(await canAccessShow({ id, role: 'OPERATOR' }, assignedShow)).toBe(false);
  });

  it('does not leak another operator assignment as if it were yours', async () => {
    const mine = await createUser('OPERATOR');
    const theirs = await createUser('OPERATOR');
    await assign(theirs, otherShow);
    expect(await canAccessShow({ id: mine, role: 'OPERATOR' }, otherShow)).toBe(false);
  });

  it('takes effect immediately when an assignment is revoked', async () => {
    // spec/admin.md §14.3: revoking takes effect on the server immediately,
    // including for a device that is currently offline.
    const id = await createUser('OPERATOR');
    await assign(id, assignedShow);
    expect(await canAccessShow({ id, role: 'OPERATOR' }, assignedShow)).toBe(true);

    await sql`delete from operator_show_assignments where user_id = ${id}::uuid`;
    expect(await canAccessShow({ id, role: 'OPERATOR' }, assignedShow)).toBe(false);
  });

  it('lets an ADMIN into every show, rostered or not', async () => {
    const id = await createUser('ADMIN');
    expect(await canAccessShow({ id, role: 'ADMIN' }, assignedShow)).toBe(true);
    expect(await canAccessShow({ id, role: 'ADMIN' }, otherShow)).toBe(true);
  });

  it('refuses a nonsense show id rather than querying with it', async () => {
    const id = await createUser('OPERATOR');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(await canAccessShow({ id, role: 'OPERATOR' }, bad)).toBe(false);
    }
  });
});
