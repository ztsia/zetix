import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { DEFAULT_TEMPLATES } from './defaults';
import { parseLayout } from './layout';

/**
 * Giving a concert its three default layouts (decision 10, spec/tickets.md §10.3).
 *
 * **A ticket template belongs to a concert.** The schema permits a null
 * `concert_id` as a global default, and this module used to write the three
 * defaults that way — one set serving everything. That was the wrong call: a
 * template is part of how a particular concert presents itself, and the pinned
 * `(ticket_template_id, ticket_template_version)` on an attendee should name a
 * row that concert owns rather than one shared with every future season.
 *
 * Making them concert-scoped also fixes a real bug rather than working around
 * it. The unique index is `(concert_id, name, version)`, and **two NULLs never
 * conflict in a Postgres unique index** — so while these rows were global the
 * index did not constrain them at all, `on conflict do nothing` had nothing to
 * fire on, and a second seed run inserted a duplicate set. With `concert_id`
 * populated the index does exactly what it looks like it does, and the
 * `where not exists` guard that used to stand in for it is gone.
 *
 * Seeding is **lazy**: a concert gets its templates the first time something
 * needs to render for it. Doing it when a concert is created would be tidier,
 * but concert CRUD belongs to module `A`, and `modules.md` §5.2 forbids a
 * wave-2 module from assuming another wave-2 module's work. Lazy keeps the
 * whole mechanism inside `D`.
 */

export type SeedTemplatesResult = {
  inserted: string[];
  /** Already present, and deliberately left as they are. */
  skipped: string[];
};

/**
 * Make sure `concertId` has the three default layouts, then leave them alone.
 *
 * Idempotent, and **never an upsert**. Each `ticket_templates` row is one
 * immutable version; attendees pin `(ticket_template_id,
 * ticket_template_version)` at issue time and rendering always uses the pinned
 * pair (§10.5). An admin who edited a seeded default has made version 2 through
 * the editor, and rewriting version 1 underneath them would change tickets that
 * were already issued against it — including the PDF already in someone's inbox.
 */
export async function ensureConcertTemplates(
  concertId: number,
): Promise<SeedTemplatesResult> {
  const db = getDb();
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const template of DEFAULT_TEMPLATES) {
    // Validate on the way in. A malformed default would fail at render time,
    // for every ticket, having looked fine in the source.
    const layout = parseLayout(template.layout);

    try {
      const rows = await db.execute<{ id: string }>(sql`
        insert into ticket_templates (
          concert_id, name, version, background_kind,
          page_width_pt, page_height_pt, layout, is_default
        ) values (
          ${concertId},
          ${template.name},
          1,
          'NONE',
          ${layout.canvas.width_pt},
          ${layout.canvas.height_pt},
          ${JSON.stringify(layout)}::text::jsonb,
          ${template.isDefault}
        )
        on conflict do nothing
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

export type ResolvedTemplate = { id: number; version: number };

/**
 * The template a concert renders with, seeding the defaults if it has none.
 *
 * This is the lazy half. Callers that are about to render or issue call it and
 * get a template back; a concert nobody has configured still produces a ticket,
 * which is the whole of decision 10.
 *
 * Returns the highest version of the row flagged `is_default`, so an admin who
 * clones and edits gets their edit without this needing to know about it.
 */
export async function resolveTemplateForConcert(
  concertId: number,
): Promise<ResolvedTemplate> {
  const existing = await findConcertTemplate(concertId);
  if (existing) return existing;

  await ensureConcertTemplates(concertId);

  const seeded = await findConcertTemplate(concertId);
  if (!seeded) {
    // Seeding ran and produced nothing selectable: the concert is gone, or its
    // templates were all soft-deleted. Both are configuration errors an admin
    // must see, and either is better than rendering an arbitrary design.
    throw new Error(
      `Concert ${concertId} has no ticket template and the defaults could not ` +
        'be seeded for it. Check the concert exists and that its templates are ' +
        'not all soft-deleted.',
    );
  }
  return seeded;
}

/** The concert's current default, or null when it has none yet. */
export async function findConcertTemplate(
  concertId: number,
): Promise<ResolvedTemplate | null> {
  const rows = await getDb().execute<{ id: string; version: number }>(sql`
    select id, version
      from ticket_templates
     where concert_id = ${concertId}
       and is_default
       and deleted_at is null
     order by version desc
     limit 1
  `);
  const row = rows[0];
  return row ? { id: Number(row.id), version: row.version } : null;
}
