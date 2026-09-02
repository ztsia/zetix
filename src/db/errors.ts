/**
 * Postgres errors, unwrapped.
 *
 * Drizzle wraps a driver error in one of its own whose `message` is
 * `"Failed query: select claim_seats($1, $2, …)\nparams: …"`. That is the
 * wrong string twice over: it hides the message the database actually raised —
 * which for this module is a carefully worded sentence naming the numbers and
 * the ways out (spec/allocation.md §7.4) — and it leaks internal SQL into
 * whatever renders it.
 *
 * The original is on the `cause` chain, so walk it.
 */

/** A `postgres.js` error, in the shape this module cares about. */
type PgError = Error & {
  code?: string;
  detail?: string;
  hint?: string;
  constraint_name?: string;
};

function isPgError(value: unknown): value is PgError {
  return (
    value instanceof Error &&
    ('code' in value || 'hint' in value || 'constraint_name' in value)
  );
}

/** The driver error underneath, or the error itself if there is nothing wrapped. */
export function pgError(error: unknown): PgError | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if (isPgError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The message the database raised, with its hint when there is one.
 *
 * These messages are written to be shown to an admin — "82 active players × 2
 * base = 164 seats, but the segment holds 100. Reduce the quota to 1…" — so
 * this is what a form should display, not a stack trace.
 */
export function dbErrorMessage(error: unknown): string {
  const pg = pgError(error);
  if (!pg) return error instanceof Error ? error.message : String(error);
  return pg.hint ? `${pg.message} ${pg.hint}` : pg.message;
}

/**
 * Re-throws with the database's own message, keeping the original as `cause`.
 *
 * Wrap any call into the allocation engine with this: `claim_seats()` raises
 * named, deliberate errors ("registration 4 is cancelled, so it cannot be given
 * seats") that a caller should be able to act on.
 */
export function rethrowDbError(error: unknown): never {
  const pg = pgError(error);
  if (!pg) throw error;
  throw Object.assign(new Error(dbErrorMessage(error), { cause: error }), {
    code: pg.code,
    constraint: pg.constraint_name,
  });
}
