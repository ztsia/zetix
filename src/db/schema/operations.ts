import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { commandItemStatus, commandRunStatus } from './enums';
import { concerts } from './concerts';
import { appUsers } from './people';
import { createdAt, fk, pk } from './columns';

/**
 * `command_runs` — one run of a command over a selection (spec/v3.md §23.1).
 *
 * Preview writes nothing, so a run exists only once the admin pressed Run.
 * `selection` is what the command received — `{ filter, excludedIds }`, never a
 * client-assembled id list (§22.3) — and `params` the rest of its arguments, so
 * a run can be read back from the Activity log exactly as it was asked for.
 *
 * Runs that outlive `maxDuration` continue from the scheduler tick (§27.1).
 * `lease_until` is how two ticks, or a tick and the request that started the
 * run, avoid working the same run at once: a worker takes the run only while
 * the lease is empty or expired, and renews it as it goes.
 *
 * The counters are written as items finish so the report is one row read; the
 * items remain the truth.
 */
export const commandRuns = pgTable(
  'command_runs',
  {
    id: pk(),
    /** Null for a command that is not concert-scoped (Settings, People). */
    concertId: fk('concert_id').references(() => concerts.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    actorId: uuid('actor_id').references(() => appUsers.id, { onDelete: 'set null' }),

    selection: jsonb('selection').notNull(),
    params: jsonb('params'),
    /** The optional reason every command takes, also written to `audit_log.reason` (§23.3). */
    reason: text('reason'),

    status: commandRunStatus('status').notNull(),
    total: integer('total').notNull(),
    done: integer('done').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),

    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('command_runs_concert_started_idx').on(t.concertId, t.startedAt),
    index('command_runs_status_idx').on(t.status),
  ],
);

/**
 * `command_run_items` — one row per target of a run (spec/v3.md §23.1).
 *
 * **What makes a run resumable and a re-run cheap**: a continuation picks up the
 * `PENDING` items, and `outcome` records what was done or why the row was
 * skipped, per row, for the report. `(run_id, entity_type, entity_id)` is unique
 * so a run cannot target the same row twice.
 */
export const commandRunItems = pgTable(
  'command_run_items',
  {
    id: pk(),
    runId: fk('run_id')
      .notNull()
      .references(() => commandRuns.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    status: commandItemStatus('status').notNull(),
    /** What happened to this row — or, for `SKIPPED`, why not. */
    outcome: jsonb('outcome'),
    error: text('error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...createdAt,
  },
  (t) => [
    uniqueIndex('command_run_items_target_key').on(t.runId, t.entityType, t.entityId),
    index('command_run_items_run_status_idx').on(t.runId, t.status),
  ],
);

/**
 * `scheduler_heartbeat` — one row per tick (spec/v3.md §27.1).
 *
 * A log rather than a single row, so Home can show both "last tick 4 minutes
 * ago" and whether the recent ones succeeded. The tick route trims it to
 * `scheduler.history_days`, like `pg_cron`'s own history (§27.2).
 */
export const schedulerHeartbeat = pgTable(
  'scheduler_heartbeat',
  {
    id: pk(),
    /** What called the tick: `pg_cron`, `vercel_cron`, `console`, or `manual`. */
    source: text('source').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Per step: shows completed, messages sent, runs continued, mail synced. */
    report: jsonb('report'),
    error: text('error'),
  },
  (t) => [index('scheduler_heartbeat_started_idx').on(t.startedAt)],
);
