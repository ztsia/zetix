import type { z } from 'zod';
import type { getDb } from '@/db/client';
import type { AuditEntry } from '@/lib/audit';

/**
 * The contract every command implements (spec/v3.md §23.1).
 *
 * A command is a named server operation over a selection (§22.3), in three
 * phases — preview, run, report — and the runner (`runner.ts`) owns all three.
 * A definition supplies only what is specific to it: which rows a filter
 * matches, what each row is and whether it should be skipped, what the blast
 * radius is, and what to do to one row.
 *
 * **One row at a time, each in its own transaction.** `apply` is handed a single
 * target inside a transaction the runner opens for that target alone, so a
 * failure rolls back exactly one row, and partial progress is kept — which is
 * what makes a run resumable from the scheduler tick (§27.1) and a re-run
 * converge (§23.1: "running it again does only what is left").
 *
 * **`describe` is asked again at run time, per row.** The preview is a promise
 * about what *would* happen; by the time a row's turn comes, another admin, a
 * form submission or the previous run may have changed it. The runner re-reads
 * the row with `describe(…, { lock: true })` in the row's own transaction and
 * skips it if it no longer qualifies. That, not bookkeeping, is what makes a
 * command idempotent: a row that was already done describes itself as
 * something to skip.
 */

type Db = ReturnType<typeof getDb>;
/** The transaction handle a command works in. Same derivation as `src/lib/audit.ts`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A JSON value, for `command_run_items.outcome`. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type CommandContext<P> = {
  concertId: number;
  params: P;
  /** The signed-in user who ran it; for a continuation, whoever started the run. */
  actorId: string | null;
  /** The optional reason every command takes (§23.3). */
  reason: string | null;
};

export type RunContext<P> = CommandContext<P> & {
  runId: number;
  /**
   * Writes one `audit_log` row as part of this row's transaction, carrying the
   * actor, the reason, the concert and the run. Every change a command makes is
   * recorded through this, so the Activity log can show a run's rows together.
   */
  audit: (entry: Omit<AuditEntry, 'actorId' | 'reason' | 'concertId' | 'commandRunId'>) => Promise<void>;
};

/** One target as the preview and the report show it. */
export type TargetRow = {
  id: number;
  /** How a person would name the row: a party's contact name, a template's title. */
  label: string;
  /** Why this row will be skipped, in the admin's terms. Null when it will run. */
  skip: string | null;
  /** What will happen to this row, when that is worth saying per row. */
  detail?: string | null;
};

/**
 * One line of the blast radius (§23.3): a real count and what it means to a
 * guest. "4 tickets already delivered — their QR codes will be refused at the
 * door."
 */
export type BlastLine = {
  count: number;
  text: string;
  /** `danger` for something a guest would notice and cannot be undone. */
  tone: 'neutral' | 'warning' | 'danger';
};

export type CommandDefinition<F, P> = {
  /** Stable, dotted, stored in `command_runs.command`: `trash.restore`. */
  name: string;
  /** Stored in `command_run_items.entity_type`: `registration`, `attendee`. */
  entityType: string;
  /** Sentence-case verb for the button and the typed phrase: "Restore". */
  verb: string;
  noun: { one: string; many: string };
  /**
   * Whether the effect cannot be undone by another command. Only an
   * irreversible command can require a typed confirmation, and only when it is
   * also large (`admin.typed_confirm_above`, §23.3).
   */
  irreversible: boolean;

  filter: z.ZodType<F>;
  params: z.ZodType<P>;

  /** Every target id the filter matches in this concert, in the order to work them. */
  match: (tx: Tx, ctx: CommandContext<P>, filter: F) => Promise<number[]>;

  /**
   * The rows behind `ids` **that belong to this concert**, with a skip reason
   * for any that should not run. An id outside the concert, or gone, is simply
   * left out; the runner reports it as not found. `lock` asks for the rows to be
   * locked (`for update`) because the caller is about to change them.
   */
  describe: (
    tx: Tx,
    ctx: CommandContext<P>,
    ids: number[],
    options: { lock: boolean },
  ) => Promise<TargetRow[]>;

  /** The consequences, counted from real data, of running over `ids` (§23.3). */
  blastRadius?: (tx: Tx, ctx: CommandContext<P>, ids: number[]) => Promise<BlastLine[]>;

  /**
   * Do it to one row. Throw {@link SkipItem} to record a skip decided only now;
   * throw anything else to fail the row, which rolls back what it wrote.
   */
  apply: (tx: Tx, ctx: RunContext<P>, row: TargetRow) => Promise<Json | void>;
};

/**
 * Identity, for inference: `F` and `P` come from the zod schemas, so a
 * definition's callbacks are typed without restating them.
 */
export function defineCommand<F, P>(definition: CommandDefinition<F, P>): CommandDefinition<F, P> {
  return definition;
}

/** Thrown from `apply` when a row turns out, at run time, to need nothing. */
export class SkipItem extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipItem';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = CommandDefinition<any, any>;
