import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, newConnection, sql } from '../helpers/db';
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

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => ({
    id: '00000000-0000-0000-0000-000000000001',
    email: 'a@x',
    displayName: 'Committee',
    role: 'ADMIN',
  }),
  recordLogin: async () => {},
}));

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

  it('leaves exactly one default row in the concert', async () => {
    // A QA pass found the clone copying `is_default` and leaving both rows
    // flagged. `findConcertTemplate()` orders across names as well as versions,
    // so two flagged lineages would resolve by version number rather than by
    // anybody's choice — and §5.1 describes a concert as having exactly one.
    await issueFor(1);
    const pinned = await templateNamed('Classic Landscape');
    const result = await saveTemplate({
      concertId,
      templateId: pinned.id,
      name: pinned.name,
      layout: pinned.layout,
    });

    const flagged = (await listTemplates(concertId)).filter((t) => t.isDefault);
    expect(flagged.map((t) => t.id)).toEqual([result.templateId]);
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

  it('derives the background kind rather than copying it', async () => {
    // The one place `background_kind` was passed rather than computed, so a row
    // whose kind had drifted from its path propagated the drift into a new
    // lineage. Arranged by writing a deliberately wrong pair.
    const source = await templateNamed('Classic Landscape');
    await sql`
      update ticket_templates
         set background_asset_path = 'concerts/1/art.png', background_kind = 'PDF'
       where id = ${source.id}
    `;

    const { templateId } = await duplicateTemplate(concertId, source.id);
    expect(await loadTemplate(concertId, templateId)).toMatchObject({
      backgroundAssetPath: 'concerts/1/art.png',
      backgroundKind: 'IMAGE',
    });
  });

  it('does not collide with an existing copy', async () => {
    const source = await templateNamed('Classic Landscape');
    await duplicateTemplate(concertId, source.id);
    const { templateId } = await duplicateTemplate(concertId, source.id);
    expect((await loadTemplate(concertId, templateId))?.name).toBe('Classic Landscape copy 2');
  });
});

describe('saveTemplate, under a concurrent blast', () => {
  it('waits for the issue to commit, then clones instead of rewriting', async () => {
    // **The test the `for update` lock exists for.** A QA pass found the lock
    // untested: deleting it left every other test in this file green, because
    // the pinning UPDATE happens to take FOR KEY SHARE on the template row
    // through the `attendees_ticket_template_id_...` foreign key. The outcome
    // was right, resting on a constraint nobody had named, with nothing to
    // notice if it changed. This fails without the explicit lock.
    const template = await templateNamed('Classic Landscape');
    const originalLayout = JSON.stringify(template.layout);
    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 1,
      allocationType: 'BASE',
    });

    // A blast pins the attendee to v1 but has not committed yet.
    const issuer = newConnection();
    let saved: { cloned: boolean; version: number } | null = null;
    try {
      await issuer`begin`;
      await issuer`
        update attendees
           set ticket_template_id = ${template.id},
               ticket_template_version = ${template.version},
               ticket_issued_at = now()
         where show_id = ${showId}
      `;

      // The admin presses Save in the same moment.
      const save = saveTemplate({
        concertId,
        templateId: template.id,
        name: template.name,
        layout: withElement(template.layout, 'el_raced'),
      });

      const raced = await Promise.race([
        save.then(() => ({ waited: false })),
        new Promise<{ waited: true }>((resolve) =>
          setTimeout(() => resolve({ waited: true }), 1000),
        ),
      ]);
      // It must still be blocked: reading the issued count without the lock
      // would see zero and rewrite v1 underneath the attendee.
      expect(raced.waited).toBe(true);

      await issuer`commit`;
      saved = await save;
    } finally {
      await issuer`rollback`.catch(() => undefined);
      await issuer.end();
    }

    const v1 = await loadTemplate(concertId, template.id);
    const [pin] = await sql<{ version: number }[]>`
      select ticket_template_version as version from attendees order by id limit 1
    `;

    expect({
      cloned: saved?.cloned,
      v1Unchanged: JSON.stringify(v1?.layout) === originalLayout,
      pinnedTo: pin.version,
    }).toEqual({ cloned: true, v1Unchanged: true, pinnedTo: template.version });
  });
});

describe('background assets are never deleted by a save', () => {
  it('keeps the artwork a pinned version still renders from', async () => {
    // The Blocker a QA pass found. A path is not owned by one row: a clone
    // copies it onto the new version, so "the in-place save that changed the
    // path leaves the old file unreferenced" was false, and replacing the
    // background on the newer row unlinked the artwork an already-issued
    // ticket renders from (§10.5).
    const dir = await mkdtemp(join(tmpdir(), 'zetix-save-assets-'));
    process.env.TICKET_ASSET_DIR = dir;
    try {
      // The action writes an audit row, whose actor_id is a real FK.
      await sql`
        insert into app_users (id, email, display_name, role)
        values ('00000000-0000-0000-0000-000000000001'::uuid,
                'committee@example.test', 'Committee', 'ADMIN')
        on conflict (id) do nothing
      `;

      const { putAsset, getAsset } = await import('@/lib/tickets/assets');
      const { saveTemplateAction } = await import(
        '@/app/(admin)/admin/concerts/[concertId]/tickets/templates/actions'
      );

      const artwork = await putAsset({
        concertId,
        contentType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      });

      const template = await templateNamed('Classic Landscape');
      await saveTemplate({
        concertId,
        templateId: template.id,
        name: template.name,
        layout: template.layout,
        backgroundAssetPath: artwork,
      });

      // Issue against it, then edit: v2 is a clone naming the same file.
      await issueFor(1);
      const clone = await saveTemplate({
        concertId,
        templateId: template.id,
        name: template.name,
        layout: withElement(template.layout, 'el_after'),
      });
      expect(clone.cloned).toBe(true);
      expect((await loadTemplate(concertId, clone.templateId))?.backgroundAssetPath).toBe(artwork);

      // Replace the background on v2, which has nothing issued against it.
      const replacement = await putAsset({
        concertId,
        contentType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]),
      });
      const result = await saveTemplateAction({
        concertId,
        templateId: clone.templateId,
        name: template.name,
        layout: withElement(template.layout, 'el_after'),
        backgroundAssetPath: replacement,
      });
      if (!result.ok) throw new Error(`saveTemplateAction refused: ${result.error}`);

      // v1 is pinned and still names the original file, which must still exist.
      expect((await loadTemplate(concertId, template.id))?.backgroundAssetPath).toBe(artwork);
      expect(await getAsset(artwork)).not.toBeNull();
    } finally {
      delete process.env.TICKET_ASSET_DIR;
    }
  });
});
