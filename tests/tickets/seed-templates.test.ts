import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureConcertTemplates,
  findConcertTemplate,
  resolveTemplateForConcert,
} from '@/lib/tickets/seed-templates';
import { parseLayout } from '@/lib/tickets/layout';
import { resetDb, sql } from '../helpers/db';
import { createConcert } from '../helpers/fixtures';

/**
 * Giving a concert its default layouts (decision 10, spec/tickets.md §10.3).
 *
 * Two properties matter more than the insert working:
 *
 *  - **A second run cannot change a row that already exists.** Attendees pin
 *    `(ticket_template_id, ticket_template_version)` at issue time and rendering
 *    always uses the pinned pair (§10.5), so rewriting version 1 under an issued
 *    ticket changes what a guest's PDF renders as, days after it was sent.
 *  - **Templates belong to a concert.** One concert's design must never be
 *    reachable as another's default.
 */

async function templatesFor(concertId: number) {
  return sql<
    {
      id: string; name: string; version: number; concert_id: string;
      is_default: boolean; page_width_pt: number; page_height_pt: number;
      background_kind: string; layout: unknown;
    }[]
  >`select * from ticket_templates where concert_id = ${concertId} order by name`;
}

describe('seeding a concert with the default templates', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert('Seeded');
  });

  it('writes the three layouts against that concert', async () => {
    const result = await ensureConcertTemplates(concertId);

    expect(result.inserted).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
    const rows = await templatesFor(concertId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Number(row.concert_id)).toBe(concertId);
      expect(row.version).toBe(1);
      // No artwork required — that is what makes them usable before module E.
      expect(row.background_kind).toBe('NONE');
    }
  });

  it('stores a layout that still validates when read back', async () => {
    // `::text::jsonb` versus `::jsonb` is a documented trap in this project: a
    // double-encoded blob stores one level too deep and parses as a string.
    await ensureConcertTemplates(concertId);
    for (const row of await templatesFor(concertId)) {
      expect(() => parseLayout(row.layout)).not.toThrow();
    }
  });

  it('records the page size from the layout canvas', async () => {
    await ensureConcertTemplates(concertId);
    const rows = await templatesFor(concertId);
    const landscape = rows.find((r) => r.name === 'Classic Landscape')!;
    expect(landscape.page_width_pt).toBe(595);
    expect(landscape.page_height_pt).toBe(280);
    const portrait = rows.find((r) => r.name === 'Minimal Portrait')!;
    expect(portrait.page_height_pt).toBeGreaterThan(portrait.page_width_pt);
  });

  it('is idempotent across many runs, with no duplicate rows', async () => {
    // The unique index is `(concert_id, name, version)`. It only does its job
    // because `concert_id` is populated: **two NULLs never conflict in a
    // Postgres unique index**, so while these rows were global the index did
    // not constrain them and every run inserted a fresh set of three.
    for (let i = 0; i < 4; i++) await ensureConcertTemplates(concertId);

    const rows = await templatesFor(concertId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
  });

  it('lets the database refuse a duplicate, rather than application SQL', async () => {
    // The guarantee above should come from the index, not from a `where not
    // exists` that a later edit could drop. Asserted directly.
    await ensureConcertTemplates(concertId);

    await expect(
      sql`
        insert into ticket_templates (
          concert_id, name, version, background_kind,
          page_width_pt, page_height_pt, layout, is_default
        ) values (
          ${concertId}, 'Classic Landscape', 1, 'NONE', 595, 280,
          '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, false
        )
      `,
    ).rejects.toThrow();
  });

  it('never rewrites a seeded row that has been edited', async () => {
    // §10.5's actual failure mode. An admin edits a default; something re-runs
    // the seed; version 1 is silently restored; every ticket issued against
    // version 1 now renders as the original design — including the PDF already
    // in someone's inbox, which no longer matches.
    await ensureConcertTemplates(concertId);
    await sql`
      update ticket_templates
         set layout = '{"canvas":{"width_pt":1,"height_pt":1,"dpi":300},"elements":[]}'::jsonb
       where concert_id = ${concertId} and name = 'Classic Landscape'
    `;

    await ensureConcertTemplates(concertId);

    const [row] = await sql<{ layout: { canvas: { width_pt: number } } }[]>`
      select layout from ticket_templates
       where concert_id = ${concertId} and name = 'Classic Landscape'
    `;
    expect(row.layout.canvas.width_pt).toBe(1);
  });

  it('marks exactly one row as the default', async () => {
    await ensureConcertTemplates(concertId);
    const rows = await templatesFor(concertId);
    expect(rows.filter((r) => r.is_default)).toHaveLength(1);
    expect(rows.find((r) => r.is_default)!.name).toBe('Classic Landscape');
  });

  it('leaves another concert with none of its own', async () => {
    const other = await createConcert('Other');
    await ensureConcertTemplates(concertId);

    expect(await templatesFor(other)).toHaveLength(0);
    expect(await findConcertTemplate(other)).toBeNull();
  });
});

describe('resolving the template to render with', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert('Lazy');
  });

  it('seeds on first use, so an unconfigured concert still renders', async () => {
    // Decision 10, and the reason seeding is lazy rather than on concert
    // creation: concert CRUD is module A's, and a wave-2 module must not depend
    // on another wave-2 module (modules.md §5.2).
    expect(await findConcertTemplate(concertId)).toBeNull();

    const resolved = await resolveTemplateForConcert(concertId);

    const [row] = await sql<{ name: string; concert_id: string }[]>`
      select name, concert_id from ticket_templates where id = ${resolved.id}
    `;
    expect(row.name).toBe('Classic Landscape');
    expect(Number(row.concert_id)).toBe(concertId);
    expect(resolved.version).toBe(1);
  });

  it('does not re-seed once the concert has templates', async () => {
    await resolveTemplateForConcert(concertId);
    const before = await templatesFor(concertId);

    await resolveTemplateForConcert(concertId);

    expect(await templatesFor(concertId)).toHaveLength(before.length);
  });

  it('returns each concert its own template, never the other one', async () => {
    const a = concertId;
    const b = await createConcert('Second');

    const ra = await resolveTemplateForConcert(a);
    const rb = await resolveTemplateForConcert(b);

    expect(ra.id).not.toBe(rb.id);
    const rows = await sql<{ id: string; concert_id: string }[]>`
      select id, concert_id from ticket_templates where id in (${ra.id}, ${rb.id})
    `;
    const byId = new Map(rows.map((r) => [Number(r.id), Number(r.concert_id)]));
    expect(byId.get(ra.id)).toBe(a);
    expect(byId.get(rb.id)).toBe(b);
  });

  it('picks the newest version when the default has been revised', async () => {
    // Editing a template creates a new version rather than mutating the old one
    // (§10.5), so "the default" means the latest version of the default.
    await resolveTemplateForConcert(concertId);
    const [v1] = await sql<{ id: string }[]>`
      select id from ticket_templates
       where concert_id = ${concertId} and name = 'Classic Landscape'
    `;
    await sql`
      insert into ticket_templates (
        concert_id, name, version, supersedes_id, background_kind,
        page_width_pt, page_height_pt, layout, is_default
      ) values (
        ${concertId}, 'Classic Landscape', 2, ${Number(v1.id)}, 'NONE', 595, 280,
        '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, true
      )
    `;

    expect((await resolveTemplateForConcert(concertId)).version).toBe(2);
  });

  it('ignores a soft-deleted template', async () => {
    await resolveTemplateForConcert(concertId);
    await sql`
      update ticket_templates set deleted_at = now()
       where concert_id = ${concertId} and is_default
    `;
    // Seeding cannot help — the row exists, so the insert is a no-op — and
    // rendering an arbitrary template would be worse than saying so.
    await expect(resolveTemplateForConcert(concertId)).rejects.toThrow(
      /no ticket template/,
    );
  });
});
