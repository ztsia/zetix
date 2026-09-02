import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { importStatus } from './enums';
import { appUsers } from './people';
import { shows, showSegments } from './shows';
import { createdAt, fk, pk, timestamps } from './columns';

/**
 * `mapping_profiles` — a saved column mapping for spreadsheet import
 * (spec/import.md §9.3).
 *
 * Google Forms exports change shape between rounds; a saved profile means the
 * second round is not a fresh mapping exercise. `show_id` null makes a profile
 * reusable across shows.
 */
export const mappingProfiles = pgTable('mapping_profiles', {
  id: pk(),
  name: text('name').notNull(),
  showId: fk('show_id').references(() => shows.id, { onDelete: 'cascade' }),
  audience: text('audience'),
  config: jsonb('config').notNull(),
  ...timestamps,
});

/**
 * `import_batches` — one import run, dry run or committed (spec/import.md §9.1).
 *
 * One run per segment, and after commit this database is the source of truth:
 * there is no rollback and no re-sync back to the spreadsheet (decision 26).
 * `report` holds the per-row outcome so a committed run stays explainable.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: pk(),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    segmentId: fk('segment_id')
      .notNull()
      .references(() => showSegments.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mappingProfileId: fk('mapping_profile_id').references(() => mappingProfiles.id, {
      onDelete: 'set null',
    }),
    uploadedBy: uuid('uploaded_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    rowCount: integer('row_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    report: jsonb('report'),
    status: importStatus('status').notNull(),
    ...createdAt,
  },
  (t) => [index('import_batches_segment_idx').on(t.segmentId, t.status)],
);
