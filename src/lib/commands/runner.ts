import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import {
  SkipItem,
  type AnyCommand,
  type BlastLine,
  type CommandContext,
  type Json,
  type RunContext,
  type TargetRow,
  type Tx,
} from './define';
import { idSchema, isFilterSelection, selectionSchema, type Selection } from './selection';

/**
 * The command runner: preview → run → report (spec/v3.md §23.1).
 *
 * Every command in the console goes through here, so the three properties the
 * spec asks of all of them are made once:
 *
 * 1. **Preview writes nothing.** It runs in a read-only transaction, and the
 *    database refuses a write rather than trusting that no definition tried.
 * 2. **A run survives its request.** Targets are written to
 *    `command_run_items` before any is touched, then worked one per
 *    transaction. A run that outlives its time budget is left `RUNNING` with its
 *    lease released, and whoever calls next — the console's own loop or the
 *    scheduler tick (§27.1) — picks up the `PENDING` rows.
 * 3. **A re-run does only what is left.** Each row is re-described at its turn,
 *    under a lock, and a row that no longer qualifies is skipped with the
 *    definition's reason (`define.ts`).
 *
 * **The lease** (`command_runs.lease_until`) keeps two workers off one run. It
 * is taken and renewed only by a conditional `update … returning`, never read
 * and then written, and its value doubles as the holder's fencing token: every
 * row's transaction begins by renewing the lease *from the exact value this
 * worker last wrote*, so a worker whose lease expired and was taken by someone
 * else finds zero rows and stops before touching anything. That first update
 * also locks the run row for the rest of the row's transaction, which fixes
 * the lock order — run, then item — for workers and for {@link cancelRun}
 * alike, so the two cannot deadlock.
 */

/**
 * How long a worker's claim on a run lasts without renewal.
 *
 * Infrastructure, not an operational value (`CLAUDE.md`): it has to outlast one
 * row's transaction and is sized against the platform's function limit — a
 * request killed mid-run leaves its lease to expire, and the next tick takes the
 * run over. Renewed after every row, so a long run never runs out of it.
 */
const LEASE = sql.raw(`interval '60 seconds'`);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** What every command receives across the Server Action boundary. */
export type CommandInput = {
  concertId: number;
  selection: unknown;
  params?: unknown;
  reason?: string | null;
  /** The typed phrase, when the preview asked for one (§23.3). */
  confirmPhrase?: string | null;
};

/**
 * A request the runner will not act on, phrased for the admin: a malformed
 * selection, a missing typed confirmation, an empty selection. The Server
 * Action shows its message; nothing was written.
 */
export class CommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandInputError';
  }
}

type Parsed = {
  ctx: CommandContext<unknown>;
  selection: Selection<unknown>;
  confirmPhrase: string | null;
};

const reasonSchema = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((value) => (value ? value : null));

function parse(def: AnyCommand, input: CommandInput, actorId: string | null): Parsed {
  const shape = z.object({
    concertId: idSchema,
    selection: selectionSchema(def.filter),
    params: def.params,
    reason: reasonSchema,
    confirmPhrase: z.string().nullish(),
  });
  const result = shape.safeParse({ ...input, params: input.params ?? {} });
  if (!result.success) {
    throw new CommandInputError(`That request to ${def.verb.toLowerCase()} was malformed.`);
  }
  const { concertId, selection, params, reason, confirmPhrase } = result.data;
  return {
    ctx: { concertId, params, actorId, reason },
    selection: selection as Selection<unknown>,
    confirmPhrase: confirmPhrase ?? null,
  };
}

/**
 * The target ids, in working order. A filter is resolved here, inside the
 * caller's transaction — never trusted from the browser (§22.3).
 */
async function resolveTargets(
  tx: Tx,
  def: AnyCommand,
  ctx: CommandContext<unknown>,
  selection: Selection<unknown>,
): Promise<number[]> {
  if (isFilterSelection(selection)) {
    const excluded = new Set(selection.excludedIds);
    const matched = await def.match(tx, ctx, selection.filter);
    return matched.filter((id) => !excluded.has(id));
  }
  return Array.from(new Set(selection.ids));
}

const NOT_FOUND = 'No longer exists in this concert.';

// ---------------------------------------------------------------------------
// Typed confirmation
// ---------------------------------------------------------------------------

export type Confirmation = {
  required: boolean;
  /** What to type, e.g. `delete 34 parties`. Null when not required. */
  phrase: string | null;
  /** `admin.typed_confirm_above` as resolved for this concert. */
  threshold: number | null;
};

/**
 * Whether a run needs a typed phrase: only when it is **irreversible** and
 * **large** — more rows than `admin.typed_confirm_above` (§23.3).
 *
 * The phrase names the count, so a selection that grew between preview and run
 * no longer matches what the admin typed: they confirmed 34, and 40 is a
 * different decision. A threshold nobody has set cannot be read as "never", so
 * it requires the phrase — the safe side of a missing operational value.
 */
async function confirmationFor(
  tx: Tx,
  def: AnyCommand,
  concertId: number,
  runnable: number,
): Promise<Confirmation> {
  if (!def.irreversible) return { required: false, phrase: null, threshold: null };

  const rows = await tx.execute<{ threshold: number | null }>(sql`
    select (resolve_setting('admin.typed_confirm_above', null, null, ${concertId}::bigint)
              #>> '{}')::int as threshold
  `);
  const threshold = rows[0]?.threshold ?? null;
  const required = threshold === null || runnable > threshold;
  return {
    required,
    phrase: required ? phraseFor(def, runnable) : null,
    threshold,
  };
}

export function phraseFor(def: AnyCommand, count: number): string {
  return `${def.verb.toLowerCase()} ${count} ${count === 1 ? def.noun.one : def.noun.many}`;
}

const normalisePhrase = (value: string | null) =>
  (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type PreviewRow = TargetRow;

export type Preview = {
  command: string;
  verb: string;
  noun: { one: string; many: string };
  /** Cannot be undone by another command — the dialog's Run button says so. */
  irreversible: boolean;
  /** Whether the selection was a filter, so the dialog can say it is re-resolved at run time. */
  byFilter: boolean;
  total: number;
  runnable: number;
  rows: PreviewRow[];
  /** Skipped rows grouped by reason, largest group first. */
  skipped: { reason: string; count: number }[];
  blastRadius: BlastLine[];
  confirmation: Confirmation;
};

/**
 * Phase 1 (§23.1): what would happen, per row, and what it would cost.
 *
 * A read-only transaction, so a definition that wrote by mistake fails loudly
 * here instead of changing data behind a preview.
 */
export async function previewCommand(
  def: AnyCommand,
  input: CommandInput,
  actorId: string | null,
): Promise<Preview> {
  const { ctx, selection } = parse(def, input, actorId);

  return getDb().transaction(
    async (tx) => {
      const ids = await resolveTargets(tx, def, ctx, selection);
      const described = ids.length > 0 ? await def.describe(tx, ctx, ids, { lock: false }) : [];
      const byId = new Map(described.map((row) => [row.id, row]));

      const rows: PreviewRow[] = ids.map(
        (id) => byId.get(id) ?? { id, label: `#${id}`, skip: NOT_FOUND },
      );
      const runnableIds = rows.filter((row) => row.skip === null).map((row) => row.id);

      const reasons = new Map<string, number>();
      for (const row of rows) {
        if (row.skip !== null) reasons.set(row.skip, (reasons.get(row.skip) ?? 0) + 1);
      }

      const blastRadius =
        def.blastRadius && runnableIds.length > 0
          ? await def.blastRadius(tx, ctx, runnableIds)
          : [];

      return {
        command: def.name,
        verb: def.verb,
        noun: def.noun,
        irreversible: def.irreversible,
        byFilter: isFilterSelection(selection),
        total: ids.length,
        runnable: runnableIds.length,
        rows,
        skipped: [...reasons]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
        blastRadius,
        confirmation: await confirmationFor(tx, def, ctx.concertId, runnableIds.length),
      };
    },
    { accessMode: 'read only' },
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The run's own row, as a worker needs it. */
type ClaimedRun = {
  id: number;
  command: string;
  concertId: number;
  params: unknown;
  reason: string | null;
  actorId: string | null;
  /** The lease value this worker wrote last — its fencing token. */
  lease: string;
};

/** Why a worker stopped. */
export type WorkOutcome = 'COMPLETED' | 'PAUSED' | 'LOST_LEASE';

/**
 * Phase 2 (§23.1): record the run and its targets, then work it until done or
 * until `deadline` (epoch ms). Returns the report either way; a paused run is
 * `RUNNING` and is continued by {@link continueRun} or the tick.
 */
export async function startCommand(
  def: AnyCommand,
  input: CommandInput,
  options: { actorId: string | null; deadline: number },
): Promise<RunReport> {
  const { ctx, selection, confirmPhrase } = parse(def, input, options.actorId);

  const run = await getDb().transaction(async (tx) => {
    const ids = await resolveTargets(tx, def, ctx, selection);
    if (ids.length === 0) {
      throw new CommandInputError(`Nothing is selected to ${def.verb.toLowerCase()}.`);
    }

    if (def.irreversible) {
      const described = await def.describe(tx, ctx, ids, { lock: false });
      const runnable = described.filter((row) => row.skip === null).length;
      const confirmation = await confirmationFor(tx, def, ctx.concertId, runnable);
      const typed = normalisePhrase(confirmPhrase);
      if (confirmation.required && typed !== confirmation.phrase) {
        // A phrase of the right shape with another count was a real
        // confirmation of a different selection; anything else is a typo.
        const verb = def.verb.toLowerCase();
        const otherCount =
          typed.startsWith(`${verb} `) &&
          /^\d+ /.test(typed.slice(verb.length + 1)) &&
          (typed.endsWith(` ${def.noun.one}`) || typed.endsWith(` ${def.noun.many}`));
        throw new CommandInputError(
          otherCount
            ? `The selection now comes to ${runnable} ${runnable === 1 ? def.noun.one : def.noun.many}, ` +
                `not what was confirmed. Preview it again, then type "${confirmation.phrase}".`
            : `Type "${confirmation.phrase}" to confirm.`,
        );
      }
    }

    const [created] = await tx.execute<{ id: string; lease: string }>(sql`
      insert into command_runs (concert_id, command, actor_id, selection, params, reason,
                                status, total, lease_until)
      values (${ctx.concertId}, ${def.name}, ${ctx.actorId},
              ${JSON.stringify(selection)}::jsonb, ${JSON.stringify(ctx.params ?? null)}::jsonb,
              ${ctx.reason}, 'RUNNING', ${ids.length}, now() + ${LEASE})
      returning id, lease_until::text as lease
    `);
    const runId = Number(created.id);

    await tx.execute(sql`
      insert into command_run_items (run_id, entity_type, entity_id, status)
      select ${runId}, ${def.entityType}, t.id, 'PENDING'
        from unnest(${`{${ids.join(',')}}`}::bigint[]) with ordinality as t(id, n)
       order by t.n
    `);

    return {
      id: runId,
      command: def.name,
      concertId: ctx.concertId,
      params: ctx.params,
      reason: ctx.reason,
      actorId: ctx.actorId,
      lease: created.lease,
    } satisfies ClaimedRun;
  });

  await workRun(def, run, options.deadline);
  return readRun(run.id, ctx.concertId);
}

/**
 * Works `PENDING` rows one transaction at a time until none remain, the
 * deadline passes, or the lease is lost.
 */
async function workRun(def: AnyCommand, run: ClaimedRun, deadline: number): Promise<WorkOutcome> {
  const db = getDb();
  let lease = run.lease;
  const ctx: CommandContext<unknown> = {
    concertId: run.concertId,
    params: run.params,
    actorId: run.actorId,
    reason: run.reason,
  };

  for (;;) {
    if (Date.now() >= deadline) {
      // Release rather than let it run out, so the next caller need not wait.
      await db.execute(sql`
        update command_runs set lease_until = null
         where id = ${run.id} and lease_until::text = ${lease}
      `);
      return 'PAUSED';
    }

    const step = await db.transaction(async (tx) => {
      // Fencing and lock order: renew from our own token, which also locks the
      // run row until this transaction ends (see the module comment).
      const renewed = await tx.execute<{ lease: string }>(sql`
        update command_runs
           set lease_until = now() + ${LEASE}, updated_at = now()
         where id = ${run.id}
           and status = 'RUNNING'
           and lease_until::text = ${lease}
        returning lease_until::text as lease
      `);
      if (renewed.length === 0) return { kind: 'lost' as const };
      const nextLease = renewed[0].lease;

      const [item] = await tx.execute<{ id: string; entity_id: string }>(sql`
        select id, entity_id from command_run_items
         where run_id = ${run.id} and status = 'PENDING'
         order by id
         limit 1
         for update skip locked
      `);

      if (!item) {
        await tx.execute(sql`
          update command_runs
             set status = 'COMPLETED', finished_at = now(), lease_until = null
           where id = ${run.id}
        `);
        return { kind: 'completed' as const };
      }

      const result = await workItem(tx, def, ctx, run.id, Number(item.entity_id));

      await tx.execute(sql`
        update command_run_items
           set status = ${result.status}::command_item_status,
               outcome = ${result.outcome === undefined ? null : JSON.stringify(result.outcome)}::jsonb,
               error = ${result.error ?? null},
               processed_at = now()
         where id = ${Number(item.id)}
      `);
      await tx.execute(sql`
        update command_runs
           set done    = done    + ${result.status === 'DONE' ? 1 : 0},
               skipped = skipped + ${result.status === 'SKIPPED' ? 1 : 0},
               failed  = failed  + ${result.status === 'FAILED' ? 1 : 0}
         where id = ${run.id}
      `);
      return { kind: 'worked' as const, lease: nextLease };
    });

    if (step.kind === 'lost') return 'LOST_LEASE';
    if (step.kind === 'completed') return 'COMPLETED';
    lease = step.lease;
  }
}

type ItemResult = {
  status: 'DONE' | 'SKIPPED' | 'FAILED';
  outcome?: Json;
  error?: string;
};

/**
 * One row, inside its own savepoint: a failure rolls back exactly what this row
 * wrote, and the row is still recorded as `FAILED` in the enclosing
 * transaction, so the report says what went wrong instead of the run stalling
 * on the same row forever.
 */
async function workItem(
  tx: Tx,
  def: AnyCommand,
  ctx: CommandContext<unknown>,
  runId: number,
  entityId: number,
): Promise<ItemResult> {
  try {
    return await tx.transaction(async (sp) => {
      const [row] = await def.describe(sp, ctx, [entityId], { lock: true });
      if (!row) return { status: 'SKIPPED', outcome: { reason: NOT_FOUND } };
      if (row.skip !== null) return { status: 'SKIPPED', outcome: { reason: row.skip } };

      const runCtx: RunContext<unknown> = {
        ...ctx,
        runId,
        audit: (entry) =>
          writeAuditLog(
            {
              ...entry,
              actorId: ctx.actorId,
              reason: ctx.reason,
              concertId: ctx.concertId,
              commandRunId: runId,
            },
            sp,
          ),
      };
      const outcome = await def.apply(sp, runCtx, row);
      return { status: 'DONE', outcome: outcome ?? { label: row.label } };
    });
  } catch (error) {
    if (error instanceof SkipItem) {
      return { status: 'SKIPPED', outcome: { reason: error.reason } };
    }
    return { status: 'FAILED', error: dbErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

const claimColumns = sql`
  id, command, concert_id, params, reason, actor_id, lease_until::text as lease
`;

type ClaimRow = {
  id: string;
  command: string;
  concert_id: string;
  params: unknown;
  reason: string | null;
  actor_id: string | null;
  lease: string;
};

const toClaimed = (row: ClaimRow): ClaimedRun => ({
  id: Number(row.id),
  command: row.command,
  concertId: Number(row.concert_id),
  params: row.params,
  reason: row.reason,
  actorId: row.actor_id,
  lease: row.lease,
});

/**
 * Continue one run — the console's own loop, while the report is open.
 * Does nothing if another worker holds the lease.
 */
export async function continueRun(
  def: AnyCommand,
  runId: number,
  concertId: number,
  deadline: number,
): Promise<RunReport> {
  const [row] = await getDb().execute<ClaimRow>(sql`
    update command_runs
       set lease_until = now() + ${LEASE}
     where id = ${runId}
       and concert_id = ${concertId}
       and command = ${def.name}
       and status = 'RUNNING'
       and (lease_until is null or lease_until < now())
    returning ${claimColumns}
  `);
  if (row) await workRun(def, toClaimed(row), deadline);
  return readRun(runId, concertId);
}

export type ContinueSummary = { worked: number; completed: number; failed: number };

/**
 * The scheduler tick's share (§27.1): take unleased `RUNNING` runs, oldest
 * first, and work each until done or until the deadline. `lookup` resolves a
 * stored command name to its definition; a run whose command no longer exists
 * in the code is closed as `FAILED` rather than retried on every tick.
 */
export async function continueCommandRuns(options: {
  deadline: number;
  lookup: (name: string) => AnyCommand | undefined;
}): Promise<ContinueSummary> {
  const db = getDb();
  const summary: ContinueSummary = { worked: 0, completed: 0, failed: 0 };

  while (Date.now() < options.deadline) {
    const [row] = await db.execute<ClaimRow>(sql`
      update command_runs
         set lease_until = now() + ${LEASE}
       where id = (
         select id from command_runs
          where status = 'RUNNING'
            and (lease_until is null or lease_until < now())
          order by started_at, id
          limit 1
          for update skip locked
       )
      returning ${claimColumns}
    `);
    if (!row) break;

    const run = toClaimed(row);
    const def = options.lookup(run.command);
    if (!def) {
      await db.execute(sql`
        update command_runs
           set status = 'FAILED', finished_at = now(), lease_until = null
         where id = ${run.id} and lease_until::text = ${run.lease}
      `);
      summary.failed++;
      continue;
    }

    summary.worked++;
    const outcome = await workRun(def, run, options.deadline);
    if (outcome === 'COMPLETED') summary.completed++;
    if (outcome === 'PAUSED') break;
  }
  return summary;
}

/**
 * Stop a run. Rows not yet worked are recorded as skipped, so the report still
 * accounts for every target. A row mid-flight finishes first: this waits on the
 * run row, which that row's transaction holds.
 */
export async function cancelRun(
  runId: number,
  concertId: number,
): Promise<RunReport> {
  await getDb().transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update command_runs
         set status = 'CANCELLED', finished_at = now(), lease_until = null
       where id = ${runId} and concert_id = ${concertId} and status = 'RUNNING'
      returning id
    `);
    if (updated.length === 0) return;

    const skipped = await tx.execute<{ id: string }>(sql`
      update command_run_items
         set status = 'SKIPPED',
             outcome = '{"reason":"Cancelled before its turn."}'::jsonb,
             processed_at = now()
       where run_id = ${runId} and status = 'PENDING'
      returning id
    `);
    await tx.execute(sql`
      update command_runs set skipped = skipped + ${skipped.length} where id = ${runId}
    `);
  });
  return readRun(runId, concertId);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type RunReport = {
  id: number;
  command: string;
  status: RunStatus;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  reason: string | null;
  actorId: string | null;
  startedAt: string;
  finishedAt: string | null;
  items: {
    entityType: string;
    entityId: number;
    status: 'PENDING' | 'DONE' | 'SKIPPED' | 'FAILED';
    outcome: Json | null;
    error: string | null;
  }[];
};

/** Phase 3 (§23.1): the run and every row's outcome. Scoped to the concert. */
export async function readRun(runId: number, concertId: number): Promise<RunReport> {
  const db = getDb();
  const [run] = await db.execute<{
    id: string;
    command: string;
    status: RunStatus;
    total: number;
    done: number;
    skipped: number;
    failed: number;
    reason: string | null;
    actor_id: string | null;
    started_at: string;
    finished_at: string | null;
  }>(sql`
    select id, command, status, total, done, skipped, failed, reason, actor_id,
           to_json(started_at) #>> '{}' as started_at,
           to_json(finished_at) #>> '{}' as finished_at
      from command_runs
     where id = ${runId} and concert_id = ${concertId}
  `);
  if (!run) throw new CommandInputError('That run does not exist in this concert.');

  const items = await db.execute<{
    entity_type: string;
    entity_id: string;
    status: RunReport['items'][number]['status'];
    outcome: Json | null;
    error: string | null;
  }>(sql`
    select entity_type, entity_id, status, outcome, error
      from command_run_items
     where run_id = ${runId}
     order by id
  `);

  return {
    id: Number(run.id),
    command: run.command,
    status: run.status,
    total: run.total,
    done: run.done,
    skipped: run.skipped,
    failed: run.failed,
    reason: run.reason,
    actorId: run.actor_id,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    items: items.map((item) => ({
      entityType: item.entity_type,
      entityId: Number(item.entity_id),
      status: item.status,
      outcome: item.outcome,
      error: item.error,
    })),
  };
}
