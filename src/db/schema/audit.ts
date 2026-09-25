import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { appUsers } from './people';
import { commandRuns } from './operations';
import { createdAt, fk, pk } from './columns';

/**
 * `audit_log` — every admin override (spec/domain.md §5.1, spec/README.md §2.4).
 *
 * Overrides are recorded, never silently blocked: exceeding a segment's
 * capacity, granting extras out of order, admitting a red scan at the door.
 * `before` and `after` hold the row either side of the change so the record
 * stands on its own without re-deriving state.
 *
 * `actor_id` is nullable and, for admin actions, is the *shared* ADMIN account —
 * attribution to an individual person is the accepted cost of decision 19. The
 * schema would support individual admins unchanged if that ever changes.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    actorId: uuid('actor_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),

    /** The typed confirmation an admin gives when exceeding capacity (spec/allocation.md §7.5). */
    reason: text('reason'),

    /**
     * The concert the change belongs to, so the Activity log can be read per
     * concert (spec/v3.md §23.1, §23.6). Added in `0201`.
     *
     * **Stored, not joined**, because the row it describes may be permanently
     * deleted and the log must still say where it happened. No foreign key for
     * the same reason `entity_id` has none. A writer that knows the concert
     * passes it; for every other writer `audit_log_fill_concert` derives it from
     * `entity_type` / `entity_id` on insert, so the sixty existing call sites
     * and the SQL functions that write here are scoped without being edited.
     */
    concertId: fk('concert_id'),
    /** The command run that wrote this row, when one did (§23.1). */
    commandRunId: fk('command_run_id').references(() => commandRuns.id, {
      onDelete: 'set null',
    }),
    ...createdAt,
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_concert_created_idx').on(t.concertId, t.createdAt),
    index('audit_log_command_run_idx').on(t.commandRunId),
  ],
);
