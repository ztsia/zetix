import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { issueTickets } from '@/lib/tickets/issue';
import type { Layout } from '@/lib/tickets/layout';
import { ensureConcertTemplates } from '@/lib/tickets/seed-templates';
import {
  duplicateTemplate,
  listTemplates,
  loadTemplate,
  saveTemplate,
  setDefaultTemplate,
} from '@/lib/tickets/templates';

/**
 * Saving a template edit (spec/tickets.md §10.5).
 *
 * **The rule this file exists for:** editing a template must never change a
 * ticket somebody already holds. The PDF is rendered on demand from the pinned
 * `(ticket_template_id, ticket_template_version)`, so rewriting a version that
 * has issued tickets changes what is behind a link already in someone's inbox —
 * and the door would be scanning against a design nobody sent.
 *
 * The tests below drive the real save path against a real Postgres, and the
 * assertion that matters is not "a new row appeared" but "the **old row's
 * layout is untouched** and the attendee still points at it".
 */

let concertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Templates');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  await ensureConcertTemplates(concertId);
});

/**
 * The concert's newest template of that name, so tests do not depend on ids.
 *
 * Loaded in full rather than taken from the list: `listTemplates()` returns
 * summaries, and a save needs the layout it is editing.
 */
async function templateNamed(name: string) {
  const templates = await listTemplates(concertId);
  // The list is ordered name asc, version desc, so the first match is newest.
  const found = templates.find((template) => template.name === name);
  if (!found) throw new Error(`No template called ${name}`);
  const detail = await loadTemplate(concertId, found.id);
  if (!detail) throw new Error(`Template ${found.id} vanished`);
  return detail;
}

function withElement(layout: Layout, id: string): Layout {
  return {
    ...layout,
    elements: [
      ...layout.elements,
      {
        id,
        type: 'RECT',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
        rotation: 0,
        fill: '#000000',
        stroke: null,
        stroke_width: 0,
        radius: 0,
      },
    ],
  };
}

/** Issue tickets for `count` attendees, pinning them to the current template. */
async function issueFor(count: number): Promise<void> {
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count,
    allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });
}

describe('saveTemplate, with nothing issued', () => {
  it('edits in place and keeps the version number', async () => {
    const before = await templateNamed('Classic Landscape');
    const result = await saveTemplate({
      concertId,
      templateId: before.id,
      name: before.name,
      layout: withElement(before.layout, 'el_new'),
    });

    expect(result).toMatchObject({ templateId: before.id, version: before.version, cloned: false });

    const after = await loadTemplate(concertId, before.id);
    expect(after?.layout.elements.some((element) => element.id === 'el_new')).toBe(true);

    // No version spam: an afternoon of nudging boxes must not mint 34 versions,
    // or the number stops telling an admin anything.
    const all = await listTemplates(concertId);
    expect(all.filter((template) => template.name === 'Classic Landscape')).toHaveLength(1);
  });

  it('keeps page size and background kind in step with the layout', async () => {
    const before = await templateNamed('Classic Landscape');
    await saveTemplate({
      concertId,
      templateId: before.id,
      name: before.name,
      layout: { ...before.layout, canvas: { ...before.layout.canvas, width_pt: 842, height_pt: 210 } },
      backgroundAssetPath: 'concerts/1/art.pdf',
    });

    const after = await templateNamed('Classic Landscape');
    expect(after).toMatchObject({
      pageWidthPt: 842,
      pageHeightPt: 210,
      // Derived from the stored path's extension, never passed in separately —
      // `background_kind: 'PDF'` beside a `.png` sends the renderer down the
      // wrong branch and the ticket comes out blank.
      backgroundKind: 'PDF',
      backgroundAssetPath: 'concerts/1/art.pdf',
    });
  });

  it('clears the background when the path is set to null', async () => {
    const before = await templateNamed('Classic Landscape');
    await saveTemplate({
      concertId,
      templateId: before.id,
      name: before.name,
      layout: before.layout,
      backgroundAssetPath: 'concerts/1/art.png',
    });
    await saveTemplate({
      concertId,
      templateId: before.id,
      name: before.name,
      layout: before.layout,
      backgroundAssetPath: null,
    });

    expect(await templateNamed('Classic Landscape')).toMatchObject({
      backgroundAssetPath: null,
      backgroundKind: 'NONE',
    });
  });
});

describe('saveTemplate, once tickets are issued', () => {
  it('clones instead of rewriting, and leaves the issued design untouched', async () => {
    await issueFor(3);

    const pinned = await templateNamed('Classic Landscape');
    expect(pinned.issuedCount).toBe(3);
    const originalLayout = JSON.stringify(pinned.layout);

    const result = await saveTemplate({
      concertId,
      templateId: pinned.id,
      name: pinned.name,
      layout: withElement(pinned.layout, 'el_added_after_issue'),
    });

    expect(result.cloned).toBe(true);
    expect(result.templateId).not.toBe(pinned.id);
    expect(result.version).toBe(pinned.version + 1);

    // The whole point: what the three attendees are pinned to has not moved.
    const old = await loadTemplate(concertId, pinned.id);
    expect(JSON.stringify(old?.layout)).toBe(originalLayout);

    const [attendee] = await sql<{ template_id: number; version: number }[]>`
      select ticket_template_id as template_id, ticket_template_version as version
        from attendees where show_id = ${showId} limit 1
    `;
    expect(Number(attendee.template_id)).toBe(pinned.id);
    expect(attendee.version).toBe(pinned.version);

    const clone = await loadTemplate(concertId, result.templateId);
    expect(clone?.layout.elements.some((e) => e.id === 'el_added_after_issue')).toBe(true);
    expect(clone?.issuedCount).toBe(0);
  });

  it('records what the new version was edited from', async () => {
    await issueFor(1);
    const pinned = await templateNamed('Classic Landscape');
    const result = await saveTemplate({
      concertId,
      templateId: pinned.id,
      name: pinned.name,
      layout: pinned.layout,
    });

    const [row] = await sql<{ supersedes_id: number }[]>`
      select supersedes_id from ticket_templates where id = ${result.templateId}
    `;
    expect(Number(row.supersedes_id)).toBe(pinned.id);
  });

  it('carries the default flag onto the new version', async () => {
    await issueFor(1);
    const pinned = await templateNamed('Classic Landscape');
    expect(pinned.isDefault).toBe(true);

    const result = await saveTemplate({
      concertId,
      templateId: pinned.id,
      name: pinned.name,
      layout: pinned.layout,
    });

    // Otherwise editing the default silently leaves the concert with none, and
    // the next issue resolves to whatever else happens to be flagged.
    const clone = await loadTemplate(concertId, result.templateId);
    expect(clone?.isDefault).toBe(true);
  });

  it('survives a rename that collides with another template’s name', async () => {
    await issueFor(1);
    const pinned = await templateNamed('Classic Landscape');

    // `(concert_id, name, version)` is unique, so version 1 of "Minimal
    // Portrait" already exists. Numbering the clone from the old name alone
    // would insert a second version 1 and fail on the index.
    const result = await saveTemplate({
      concertId,
      templateId: pinned.id,
      name: 'Minimal Portrait',
      layout: pinned.layout,
    });

    const clone = await loadTemplate(concertId, result.templateId);
    expect(clone?.name).toBe('Minimal Portrait');
    expect(clone?.version).toBeGreaterThan(1);
  });

  it('keeps cloning as more versions are issued against', async () => {
    await issueFor(1);
    const v1 = await templateNamed('Classic Landscape');
    const second = await saveTemplate({
      concertId,
      templateId: v1.id,
      name: v1.name,
      layout: v1.layout,
    });

    // A second party issued after the clone pins the clone, so editing it must
    // clone again rather than rewrite.
    await sql`update ticket_templates set is_default = false where id = ${v1.id}`;
    await issueFor(1);

    const third = await saveTemplate({
      concertId,
      templateId: second.templateId,
      name: v1.name,
      layout: v1.layout,
    });
    expect(third.cloned).toBe(true);
    expect(third.version).toBeGreaterThan(second.version);
  });
});

describe('saveTemplate, guarded', () => {
  it('refuses a template from another concert', async () => {
    const other = await createConcert('Someone else');
    await ensureConcertTemplates(other);
    const [theirs] = await sql<{ id: number }[]>`
      select id from ticket_templates where concert_id = ${other} limit 1
    `;

    await expect(
      saveTemplate({
        concertId,
        templateId: Number(theirs.id),
        name: 'Stolen',
        layout: { canvas: { width_pt: 100, height_pt: 100, dpi: 300 }, elements: [] },
      }),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('refuses a layout the renderer would not accept', async () => {
    const template = await templateNamed('Classic Landscape');
    await expect(
      saveTemplate({
        concertId,
        templateId: template.id,
        name: template.name,
        // A key the editor invented. `.strict()` rejects it here rather than
        // storing it for the renderer to ignore at blast time.
        layout: {
          canvas: { width_pt: 100, height_pt: 100, dpi: 300 },
          elements: [{ id: 'x', type: 'RECT', x: 0, y: 0, w: 1, h: 1, glow: true }],
        } as unknown as Layout,
      }),
    ).rejects.toThrow();
  });
});

describe('setDefaultTemplate', () => {
  it('moves the flag, leaving exactly one', async () => {
    const minimal = await templateNamed('Minimal Portrait');
    await setDefaultTemplate(concertId, minimal.id);

    const templates = await listTemplates(concertId);
    expect(templates.filter((template) => template.isDefault).map((t) => t.name)).toEqual([
      'Minimal Portrait',
    ]);
  });

  it('refuses another concert’s template', async () => {
    const other = await createConcert('Elsewhere');
    await ensureConcertTemplates(other);
    const [theirs] = await sql<{ id: number }[]>`
      select id from ticket_templates where concert_id = ${other} limit 1
    `;
    await expect(setDefaultTemplate(concertId, Number(theirs.id))).rejects.toThrow();
  });
});

describe('duplicateTemplate', () => {
  it('starts a new lineage rather than a new version', async () => {
    const source = await templateNamed('Classic Landscape');
    const { templateId } = await duplicateTemplate(concertId, source.id);
    const copy = await loadTemplate(concertId, templateId);

    expect(copy).toMatchObject({ name: 'Classic Landscape copy', version: 1, isDefault: false });
    expect(JSON.stringify(copy?.layout)).toBe(JSON.stringify(source.layout));

    const [row] = await sql<{ supersedes_id: number | null }[]>`
      select supersedes_id from ticket_templates where id = ${templateId}
    `;
    // Null, because a duplicate is not an edit of the original and nothing
    // about it should read as history they share.
    expect(row.supersedes_id).toBeNull();
  });

  it('does not collide with an existing copy', async () => {
    const source = await templateNamed('Classic Landscape');
    await duplicateTemplate(concertId, source.id);
    const { templateId } = await duplicateTemplate(concertId, source.id);
    expect((await loadTemplate(concertId, templateId))?.name).toBe('Classic Landscape copy 2');
  });
});
