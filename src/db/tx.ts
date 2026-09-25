import type { getDb } from './client';

type Db = ReturnType<typeof getDb>;

/**
 * The handle `db.transaction()` hands its callback, derived from the client
 * rather than spelled out: `PgTransaction`'s type parameters have to match the
 * driver exactly, and writing them by hand is how call sites end up casting.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
