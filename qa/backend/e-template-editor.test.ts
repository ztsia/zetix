/**
 * QA phase 4 — module `E` (template editor), against the real zetix_qa database.
 * Written by the QA reviewer, not the author. No mocks of the database here.
 *
 * Criteria under test: AC-21, AC-21s, AC-22, AC-23s, AC-24, AC-28, AC-29.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resetDb, sql, newConnection } from '../../tests/helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../../tests/helpers/fixtures';
import { issueTickets } from '@/lib/tickets/issue';
import { loadTicket } from '@/lib/tickets/load';
import { renderTicket } from '@/lib/tickets/render';
import { backgroundFor, loadTicketAsset } from '@/lib/tickets/background';
import { ensureConcertTemplates } from '@/lib/tickets/seed-templates';
import { duplicateTemplate, loadTemplate, saveTemplate } from '@/lib/tickets/templates';
import { putAsset, getAsset } from '@/lib/tickets/assets';
import type { Layout } from '@/lib/tickets/layout';

process.env.APP_URL ??= 'https://zetix.vercel.app';

let concertId: number;
let showId: number;
let segmentId: number;

/** A 1x1 red PNG, real bytes so `sniffContentType` and `sharp` both accept it. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  process.env.TICKET_ASSET_DIR = await mkdtemp(join(tmpdir(), 'qa-e-assets-'));
});

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('QA E');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  await ensureConcertTemplates(concertId);
});

async function seedParty(count: number) {
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
  return registrationId;
}

async function defaultTemplate() {
  const [row] = await sql<{ id: number }[]>`
    select id from ticket_templates
     where concert_id = ${concertId} and is_default and deleted_at is null
     order by version desc limit 1`;
  const detail = await loadTemplate(concertId, Number(row.id));
  if (!detail) throw new Error('no default template');
  return detail;
}

function moved(layout: Layout): Layout {
  return {
    ...layout,
    elements: layout.elements.map((e, i) => (i === 0 ? { ...e, x: e.x + 37 } : e)),
  };
}

async function renderFor(attendeeId: number) {
  const ticket = await loadTicket(attendeeId);
  if (!ticket) throw new Error('no ticket');
  const { pdf } = await renderTicket({
    layout: ticket.template.layout,
    data: ticket.data,
    background: await backgroundFor(ticket.template),
    loadAsset: loadTicketAsset,
  });
  return pdf;
}

/** pdf-lib stamps a creation date; hash the drawn content streams instead. */
function contentHash(pdf: Uint8Array): string {
  const text = Buffer.from(pdf).toString('latin1');
  const streams = [...text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => m[1]);
  return createHash('sha256').update(streams.join('|')).digest('hex');
}

describe('AC-21 / AC-21s — a template with issued tickets is frozen', () => {
  it('an edit clones, and the issued ticket renders identically', async () => {
    await seedParty(2);
    await issueTickets({ concertId, showId });
    const [a] = await sql<{ id: number }[]>`select id from attendees order by id limit 1`;
    const attendeeId = Number(a.id);

    const before = await renderFor(attendeeId);
    const template = await defaultTemplate();

    const result = await saveTemplate({
      concertId,
      templateId: template.id,
      name: template.name,
      layout: moved(template.layout),
    });
    expect(result.cloned).toBe(true);

    const after = await renderFor(attendeeId);
    expect(contentHash(after)).toBe(contentHash(before));

    const [pin] = await sql<{ tid: number; v: number; token: string }[]>`
      select ticket_template_id as tid, ticket_template_version as v, qr_token as token
        from attendees where id = ${attendeeId}`;
    expect(Number(pin.tid)).toBe(template.id);
    expect(pin.v).toBe(template.version);
  });
});

describe('AC-21s (background) — the artwork an issued ticket is pinned to', () => {
  it('survives an unrelated in-place save on the version that superseded it', async () => {
    // 1. Give the default template artwork, before anything is issued.
    const template = await defaultTemplate();
    const artwork = await putAsset({
      concertId,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1PX),
    });
    await saveTemplate({
      concertId,
      templateId: template.id,
      name: template.name,
      layout: template.layout,
      backgroundAssetPath: artwork,
    });

    // 2. Issue tickets against it. v1 is now frozen and pinned.
    await seedParty(1);
    await issueTickets({ concertId, showId });
    const [a] = await sql<{ id: number }[]>`select id from attendees order by id limit 1`;
    const attendeeId = Number(a.id);
    const v1 = await loadTemplate(concertId, template.id);
    expect(v1?.backgroundAssetPath).toBe(artwork);
    const before = await renderFor(attendeeId);

    // 3. Edit: clones to v2, which points at the SAME asset path.
    const clone = await saveTemplate({
      concertId,
      templateId: template.id,
      name: template.name,
      layout: moved(template.layout),
    });
    expect(clone.cloned).toBe(true);
    const v2 = await loadTemplate(concertId, clone.templateId);
    expect(v2?.backgroundAssetPath).toBe(artwork);

    // 4. Replace the background on v2 (nothing issued against it) — this is
    //    what the editor's Save does after an admin presses Replace.
    const replacement = await putAsset({
      concertId,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1PX),
    });
    // Reproduce `saveTemplateAction`'s orphan-cleanup rule exactly.
    const beforeRow = await loadTemplate(concertId, clone.templateId);
    const saved = await saveTemplate({
      concertId,
      templateId: clone.templateId,
      name: template.name,
      layout: v2!.layout,
      backgroundAssetPath: replacement,
    });
    const wouldDelete =
      !saved.cloned &&
      !!beforeRow!.backgroundAssetPath &&
      beforeRow!.backgroundAssetPath !== replacement;
    expect(wouldDelete).toBe(true); // the action deletes `artwork` here

    if (wouldDelete) {
      const { deleteAsset } = await import('@/lib/tickets/assets');
      await deleteAsset(beforeRow!.backgroundAssetPath!);
    }

    // 5. v1 still claims the artwork — but is it still there?
    const stillThere = await getAsset(artwork);
    const after = await renderFor(attendeeId);
    expect({ assetPresent: stillThere !== null, sameRender: contentHash(after) === contentHash(before) }).toEqual({
      assetPresent: true,
      sameRender: true,
    });
  });
});

describe('AC-23s — the save/issue race', () => {
  it('a save that starts while a blast is mid-issue must clone, not rewrite', async () => {
    await seedParty(1);
    const template = await defaultTemplate();
    expect(template.issuedCount).toBe(0);
    const originalLayout = JSON.stringify(template.layout);

    // T2: a blast pins the attendee to (template, v1) but has not committed.
    const issuer = newConnection();
    let saveResult: { cloned: boolean; version: number } | null = null;
    try {
      await issuer`begin`;
      await issuer`update attendees
                      set ticket_template_id = ${template.id},
                          ticket_template_version = ${template.version},
                          ticket_issued_at = now()
                    where show_id = ${showId}`;

      // T1: the admin presses Save in the same moment.
      const save = saveTemplate({
        concertId,
        templateId: template.id,
        name: template.name,
        layout: moved(template.layout),
      });

      const raced = await Promise.race([
        save.then((r) => ({ ...r, waited: false })),
        new Promise<{ waited: true }>((r) => setTimeout(() => r({ waited: true }), 1500)),
      ]);

      await issuer`commit`;
      saveResult = await save;

      // The save must not have completed before the issue committed, and it
      // must have cloned rather than rewritten v1 underneath the attendee.
      expect({ blockedUntilIssueCommitted: 'waited' in raced && raced.waited === true }).toEqual({
        blockedUntilIssueCommitted: true,
      });
    } finally {
      await issuer`rollback`.catch(() => undefined);
      await issuer.end();
    }

    const v1 = await loadTemplate(concertId, template.id);
    const [pin] = await sql<{ v: number }[]>`
      select ticket_template_version as v from attendees order by id limit 1`;

    expect({
      cloned: saveResult?.cloned,
      v1LayoutUnchanged: JSON.stringify(v1?.layout) === originalLayout,
      attendeePinnedTo: pin.v,
    }).toEqual({ cloned: true, v1LayoutUnchanged: true, attendeePinnedTo: template.version });
  });
});

describe('AC-24 — is_default after a clone', () => {
  it('leaves exactly one default row in the concert', async () => {
    await seedParty(1);
    await issueTickets({ concertId, showId });
    const template = await defaultTemplate();
    await saveTemplate({
      concertId,
      templateId: template.id,
      name: template.name,
      layout: moved(template.layout),
    });

    const flagged = await sql<{ id: number; name: string; version: number }[]>`
      select id, name, version from ticket_templates
       where concert_id = ${concertId} and is_default and deleted_at is null
       order by id`;
    expect(flagged.length).toBe(1);
  });
});

describe('AC-24 — duplicate starts a fresh lineage', () => {
  it('version 1, no supersedes_id, not default', async () => {
    const template = await defaultTemplate();
    const { templateId } = await duplicateTemplate(concertId, template.id);
    const [row] = await sql<
      { version: number; supersedes_id: number | null; is_default: boolean }[]
    >`select version, supersedes_id, is_default from ticket_templates where id = ${templateId}`;
    expect(row).toMatchObject({ version: 1, supersedes_id: null, is_default: false });
  });

  it('shares its background asset path with the original', async () => {
    const template = await defaultTemplate();
    const artwork = await putAsset({
      concertId,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1PX),
    });
    await saveTemplate({
      concertId,
      templateId: template.id,
      name: template.name,
      layout: template.layout,
      backgroundAssetPath: artwork,
    });
    const { templateId } = await duplicateTemplate(concertId, template.id);
    const copy = await loadTemplate(concertId, templateId);
    // Recorded, not asserted as correct: it is what makes the delete above
    // reachable from a second direction.
    expect(copy?.backgroundAssetPath).toBe(artwork);
  });
});

describe('AC-28 — asset paths are not file paths', () => {
  it('refuses to climb out of the store', async () => {
    const root = process.env.TICKET_ASSET_DIR!;
    await writeFile(join(root, '..', 'qa-secret.png'), 'not artwork');
    const escaped = await getAsset('../qa-secret.png').catch((e) => `threw: ${e.message}`);
    expect(typeof escaped === 'string' || escaped === null).toBe(true);
    expect(existsSync(join(root, '..', 'qa-secret.png'))).toBe(true);
  });

  it('a path with no known extension reads nothing', async () => {
    expect(await getAsset('concerts/1/../../../etc/passwd')).toBe(null);
  });
});
