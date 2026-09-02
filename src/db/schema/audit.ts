import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { appUsers } from './people';
import { createdAt, pk } from './columns';

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
    ...createdAt,
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId)],
);
