import { beforeEach, describe, expect, it } from 'vitest';
import { findDefaultTemplate, seedDefaultTemplates } from '@/lib/tickets/seed-templates';
import { parseLayout } from '@/lib/tickets/layout';
import { resetDb, sql } from '../helpers/db';
import { createConcert } from '../helpers/fixtures';

/**
 * Seeding the three default layouts (decision 10, spec/tickets.md §10.3).
 *
 * The property worth guarding is not that the insert works — it is that a
 * **second** run cannot change a row that already exists. Attendees pin
 * `(ticket_template_id, ticket_template_version)` at issue time and rendering
 * always uses the pinned pair (§10.5), so rewriting version 1 underneath an
 * issued ticket changes what a guest's PDF renders as, days after it was sent.
 */

async function templates() {
  return sql<
    {
      id: string; name: string; version: number; concert_id: string | null;
      is_default: boolean; page_width_pt: number; page_height_pt: number;
      background_kind: string; layout: unknown;
    }[]
  >`select * from ticket_templates order by name`;
}

describe('seeding the default templates', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes the three layouts as global rows', async () => {
    const result = await seedDefaultTemplates();

    expect(result.inserted).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
    const rows = await templates();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // Global: one set serves every concert (src/db/schema/tickets.ts).
      expect(row.concert_id).toBeNull();
      expect(row.version).toBe(1);
      // No artwork required — that is what makes them usable before module E.
      expect(row.background_kind).toBe('NONE');
    }
  });

  it('stores a layout that still validates when read back', async () => {
    // jsonb round-trips through the driver, and `::text::jsonb` vs `::jsonb`
    // is a documented trap in this project — a double-encoded blob stores one
    // level too deep and parses as a string, not an object.
    await seedDefaultTemplates();
    for (const row of await templates()) {
      expect(() => parseLayout(row.layout)).not.toThrow();
    }
  });

  it('records the page size from the layout canvas', async () => {
    await seedDefaultTemplates();
    const rows = await templates();
    const landscape = rows.find((r) => r.name === 'Classic Landscape')!;
    expect(landscape.page_width_pt).toBe(595);
    expect(landscape.page_height_pt).toBe(280);
    // Portrait is genuinely taller than wide, in the database and not only in
    // the source object.
    const portrait = rows.find((r) => r.name === 'Minimal Portrait')!;
    expect(portrait.page_height_pt).toBeGreaterThan(portrait.page_width_pt);
  });

  it('is idempotent — a second run inserts nothing', async () => {
    await seedDefaultTemplates();

    const again = await seedDefaultTemplates();

    expect(again.inserted).toEqual([]);
    expect(again.skipped).toHaveLength(3);
    expect(await templates()).toHaveLength(3);
  });

  it('stays idempotent across many runs, with no duplicate rows', async () => {
    // Regression, and a sharp one. The unique index is
    // `(concert_id, name, version)` and these rows are global, so `concert_id`
    // is null — and **two NULLs never conflict in a Postgres unique index**.
    // `on conflict do nothing` therefore had nothing to fire on and every run
    // inserted a fresh set of three. Duplicated defaults mean
    // `findDefaultTemplate()` picks arbitrarily between identical-looking rows,
    // and attendees pin whichever it happened to return.
    for (let i = 0; i < 4; i++) await seedDefaultTemplates();

    const rows = await templates();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
  });

  it('shows the index genuinely does not constrain global rows', async () => {
    // Stated as a test because the guard above lives in application SQL, not in
    // the schema, and the next person to write `on conflict` here deserves to
    // find out from a test rather than from duplicated production rows. The
    // real fix is a partial unique index on `(name, version) where concert_id
    // is null` — a schema change, so its own PR (modules.md §4).
    await seedDefaultTemplates();

    await sql`
      insert into ticket_templates (
        concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default
      ) values (
        null, 'Classic Landscape', 1, 'NONE', 595, 280,
        '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, false
      )
    `;

    const dupes = await sql<{ n: number }[]>`
      select count(*)::int as n from ticket_templates
       where concert_id is null and name = 'Classic Landscape' and version = 1
    `;
    // The database allowed it. If this ever returns 1, the partial index has
    // landed and `seedDefaultTemplates()` can go back to `on conflict`.
    expect(dupes[0].n).toBe(2);
  });

  it('never rewrites a seeded row that has been edited', async () => {
    // §10.5's actual failure mode. An admin edits a default; a later deploy
    // re-runs the seed; version 1 is silently restored; every ticket issued
    // against version 1 now renders as the original design — including the PDF
    // already in someone's inbox, which no longer matches.
    await seedDefaultTemplates();
    await sql`
      update ticket_templates
         set layout = '{"canvas":{"width_pt":1,"height_pt":1,"dpi":300},"elements":[]}'::jsonb
       where name = 'Classic Landscape'
    `;

    await seedDefaultTemplates();

    const [row] = await sql<{ layout: { canvas: { width_pt: number } } }[]>`
      select layout from ticket_templates where name = 'Classic Landscape'
    `;
    expect(row.layout.canvas.width_pt).toBe(1);
  });

  it('marks exactly one row as the default', async () => {
    await seedDefaultTemplates();
    const rows = await templates();
    expect(rows.filter((r) => r.is_default)).toHaveLength(1);
    expect(rows.find((r) => r.is_default)!.name).toBe('Classic Landscape');
  });
});

describe('finding the template to render with', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns nothing before anything is seeded', async () => {
    // A caller must treat this as a configuration error, not render something
    // arbitrary — an arbitrary template is a wrong ticket, not a missing one.
    expect(await findDefaultTemplate()).toBeNull();
  });

  it('returns the seeded global default', async () => {
    await seedDefaultTemplates();
    const found = await findDefaultTemplate();
    expect(found).not.toBeNull();
    const [row] = await sql<{ name: string }[]>`
      select name from ticket_templates where id = ${found!.id}
    `;
    expect(row.name).toBe('Classic Landscape');
    expect(found!.version).toBe(1);
  });

  it("prefers a concert's own default over the global one", async () => {
    await seedDefaultTemplates();
    const concertId = await createConcert('Own Template');
    await sql`
      insert into ticket_templates (
        concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default
      ) values (
        ${concertId}, 'House Style', 1, 'NONE', 595, 280,
        '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, true
      )
    `;

    const found = await findDefaultTemplate(concertId);

    const [row] = await sql<{ name: string }[]>`
      select name from ticket_templates where id = ${found!.id}
    `;
    expect(row.name).toBe('House Style');
  });

  it('falls back to the global default for a concert with none of its own', async () => {
    await seedDefaultTemplates();
    const concertId = await createConcert('No Template');

    const found = await findDefaultTemplate(concertId);

    const [row] = await sql<{ name: string; concert_id: string | null }[]>`
      select name, concert_id from ticket_templates where id = ${found!.id}
    `;
    expect(row.concert_id).toBeNull();
    expect(row.name).toBe('Classic Landscape');
  });

  it('picks the newest version when a default has been revised', async () => {
    // Editing a template creates a new version rather than mutating the old one
    // (§10.5), so "the default" means the latest version of the default.
    await seedDefaultTemplates();
    const [v1] = await sql<{ id: string }[]>`
      select id from ticket_templates where name = 'Classic Landscape'
    `;
    await sql`
      insert into ticket_templates (
        concert_id, name, version, supersedes_id, background_kind,
        page_width_pt, page_height_pt, layout, is_default
      ) values (
        null, 'Classic Landscape', 2, ${Number(v1.id)}, 'NONE', 595, 280,
        '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, true
      )
    `;

    const found = await findDefaultTemplate();

    expect(found!.version).toBe(2);
  });

  it('ignores a soft-deleted template', async () => {
    await seedDefaultTemplates();
    await sql`update ticket_templates set deleted_at = now() where is_default`;
    expect(await findDefaultTemplate()).toBeNull();
  });
});
