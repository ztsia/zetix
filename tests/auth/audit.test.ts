import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, resetDb, sql } from '../helpers/db';
import { writeAuditLog } from '../../src/lib/audit';

/**
 * The audit trail (spec/README.md §2.4, spec/domain.md §5.1).
 *
 * Overrides are recorded, never silently blocked. These go through the shipping
 * `writeAuditLog()` and read the row back out of Postgres, so a jsonb encoding
 * bug — the exact class of failure that cost module F1 a day — cannot pass.
 */
async function makeAdmin(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'Committee', 'ADMIN')
  `;
  return id;
}

type LogRow = {
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
};

const readLog = () => sql<LogRow[]>`select * from audit_log order by id`;

describe('audit log writer', () => {
  beforeEach(resetDb);

  it('records an override with both sides of the change', async () => {
    const actorId = await makeAdmin();

    await writeAuditLog({
      action: 'segment.capacity_changed',
      entityType: 'show_segments',
      entityId: 42,
      before: { capacity: 100 },
      after: { capacity: 120 },
      reason: 'Hall reconfigured',
      actorId,
    });

    const [row] = await readLog();
    expect(row.action).toBe('segment.capacity_changed');
    expect(row.entity_type).toBe('show_segments');
    // The column is text, so a numeric id must survive as its string form.
    expect(row.entity_id).toBe('42');
    expect(row.reason).toBe('Hall reconfigured');
    expect(row.actor_id).toBe(actorId);
  });

  it('stores jsonb at one level, not double-encoded', async () => {
    const actorId = await makeAdmin();
    const before = { capacity: 100, segments: ['a', 'b'], nested: { deep: true } };

    await writeAuditLog({
      action: 'x',
      entityType: 'y',
      before,
      after: null,
      actorId,
    });

    const [row] = await readLog();
    // Read back as a real object, not a string containing JSON. A double-encoded
    // write still "passes" a naive assertion, so compare the parsed shape.
    expect(row.before).toEqual(before);
    expect(typeof row.before).toBe('object');
  });

  it('accepts a null actor, for a system action with no signed-in admin', async () => {
    await writeAuditLog({ action: 'cron.ran', entityType: 'system', actorId: null });
    const [row] = await readLog();
    expect(row.actor_id).toBeNull();
  });

  it('rolls back with the change it describes when passed a transaction', async () => {
    // The whole point of the `tx` parameter: a log written on a separate
    // connection survives a rollback of the thing it describes, which is worse
    // than no log — it records an override that never happened.
    const actorId = await makeAdmin();

    await db
      .transaction(async (tx) => {
        await writeAuditLog({ action: 'will.rollback', entityType: 'test', actorId }, tx);
        throw new Error('deliberate rollback');
      })
      .catch(() => undefined);

    expect(await readLog()).toHaveLength(0);
  });

  it('commits with the change it describes when the transaction succeeds', async () => {
    const actorId = await makeAdmin();

    await db.transaction(async (tx) => {
      await writeAuditLog({ action: 'will.commit', entityType: 'test', actorId }, tx);
    });

    const rows = await readLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('will.commit');
  });
});
