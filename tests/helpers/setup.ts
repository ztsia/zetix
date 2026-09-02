import { afterAll } from 'vitest';
import { closeDb } from './db';

/**
 * One connection pool per test file, closed once when the file is done.
 *
 * Closing it from an `afterAll` inside a `describe` ends the pool for every
 * *other* describe in the same file, which surfaces as CONNECTION_ENDED on
 * whichever block happens to run second. Registering the teardown here keeps it
 * to exactly one per file.
 */
afterAll(closeDb);
