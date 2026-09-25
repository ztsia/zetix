/**
 * Every table in spec/domain.md §5.1, re-exported as one module.
 *
 * The schema **freezes when module F1 merges** (spec/modules.md §4), and again
 * when module `J` merges for V2 (`modules-v2.md` §4). A later module that needs
 * a column it does not have opens a small PR touching `src/db/schema/` alone and
 * rebases — it does not add a competing migration on its own branch, because
 * Drizzle would generate conflicting files. V3 follows the same rule: every V3
 * column is in `0200`, module `P` (`modules-v3.md`).
 */
export * from './types';
export * from './enums';
export * from './columns';
export * from './settings';
export * from './concerts';
export * from './tickets';
export * from './shows';
export * from './booklets';
export * from './people';
export * from './imports';
export * from './registrations';
export * from './feedback';
export * from './email';
export * from './email-templates';
export * from './checkin';
export * from './portal';
export * from './audit';
export * from './operations';
export * from './auth';
