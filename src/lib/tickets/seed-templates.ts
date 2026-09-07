import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { DEFAULT_TEMPLATES } from './defaults';
import { parseLayout } from './layout';

/**
 * Write the three default layouts into `ticket_templates` as global rows.
 *
 * `concert_id = null` means a global default (see `src/db/schema/tickets.ts`):
 * one set serves every concert, so a new concert can render a ticket the moment
 * it exists rather than waiting for anyone to open the editor (decision 10).
 *
 * **Version 1, and never touched again.** Each `ticket_templates` row is one
 * immutable version, because attendees pin `(ticket_template_id,
 * ticket_template_version)` at issue time and rendering always uses the pinned
 * pair (§10.5). Re-running this must therefore not update a row: an admin who
 * edited a seeded default has made version 2 through the editor, and rewriting
 * version 1 underneath them would change tickets that were already issued
 * against it. `on conflict do nothing` is the whole safety property here, not a
 * convenience.
 */
export type SeedTemplatesResult = {
  inserted: string[];
  /** Already present, and deliberately left as they are. */
  skipped: string[];
};

export async function seedDefaultTemplates(): Promise<SeedTemplatesResult> {
  const db = getDb();
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const template of DEFAULT_TEMPLATES) {
    // Validate on the way in. A malformed default would fail at render time,
    // for every ticket, having looked fine in the source.
    const layout = parseLayout(template.layout);

    try {
      /**
       * `where not exists` rather than `on conflict do nothing`, and that is a
       * correctness fix rather than a style choice.
       *
       * The unique index is `(concert_id, name, version)`, and these rows are
       * global — `concert_id` is null. **Two NULLs never conflict in a Postgres
       * unique index**, so that index does not constrain global templates at
       * all and `on conflict` had nothing to fire on: the second seed run
       * inserted a duplicate set. This is the same trap decision 22 records for
       * `email_outbox.registration_id`, in a table where nobody had looked for
       * it.
       *
       * The real fix is a partial unique index on `(name, version) where
       * concert_id is null`, which is a schema change and belongs in its own PR
       * against `main` (modules.md §4) — recorded in the handoff. Until then
       * this statement is what keeps a re-run from duplicating the defaults,
       * and the guard is inside the insert rather than a separate select so a
       * concurrent run cannot slip between the two.
       */
      const rows = await db.execute<{ id: string }>(sql`
        insert into ticket_templates (
          concert_id, name, version, background_kind,
          page_width_pt, page_height_pt, layout, is_default
        )
        select
          null,
          ${template.name},
          1,
          'NONE',
          ${layout.canvas.width_pt},
          ${layout.canvas.height_pt},
          ${JSON.stringify(layout)}::text::jsonb,
          ${template.isDefault}
        where not exists (
          select 1 from ticket_templates
           where concert_id is null
             and name = ${template.name}
             and version = 1
        )
        returning id
      `);
      if (rows.length > 0) inserted.push(template.name);
      else skipped.push(template.name);
    } catch (error) {
      rethrowDbError(error);
    }
  }

  return { inserted, skipped };
}

/**
 * The global default a fresh concert renders with.
 *
 * Returns the highest version of the row flagged `is_default`, so an admin who
 * clones and edits the seeded default gets their edit without this having to
 * know about it. Null when nothing is seeded, which the caller should treat as
 * a configuration error rather than rendering something arbitrary.
 */
export async function findDefaultTemplate(concertId?: number): Promise<
  { id: number; version: number } | null
> {
  const rows = await getDb().execute<{ id: string; version: number }>(sql`
    select id, version
      from ticket_templates
     where is_default
       and deleted_at is null
       -- A concert's own default wins over the global one: nulls-last puts the
       -- concert-scoped row first when both exist.
       and (concert_id is null or concert_id = ${concertId ?? null}::bigint)
     order by concert_id nulls last, version desc
     limit 1
  `);
  const row = rows[0];
  return row ? { id: Number(row.id), version: row.version } : null;
}
