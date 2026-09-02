/**
 * Every V1 table (spec/domain.md §5.1), re-exported as one module.
 *
 * The schema **freezes when module F1 merges** (spec/modules.md §4). A later
 * module that needs a column it does not have opens a small PR against `main`
 * touching `src/db/schema/` alone and rebases — it does not add a competing
 * migration on its own branch, because Drizzle would generate conflicting files.
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
export * from './email';
export * from './checkin';
export * from './portal';
export * from './audit';
