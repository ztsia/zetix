import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Artwork reaching the PDF (spec/tickets.md §10.3, §10.4).
 *
 * Module `D` built a renderer that accepts a background and skips `IMAGE`
 * elements, because no asset store existed to give it bytes. `E` supplies the
 * store, so these are the tests for the join: a template's artwork has to reach
 * a **real issued ticket**, not just the editor's preview, and the artwork of
 * the **pinned** version has to be the one used (§10.5).
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zetix-bg-'));
  process.env.TICKET_ASSET_DIR = dir;
  process.env.APP_URL ??= 'https://zetix.vercel.app';
});

const { backgroundFor, loadTicketAsset } = await import('@/lib/tickets/background');
const { putAsset } = await import('@/lib/tickets/assets');
const { renderTicket } = await import('@/lib/tickets/render');
const { loadTicket } = await import('@/lib/tickets/load');
const { issueTickets } = await import('@/lib/tickets/issue');
const { ensureConcertTemplates } = await import('@/lib/tickets/seed-templates');
const { listTemplates } = await import('@/lib/tickets/templates');

/** A real 1×1 PNG — pdf-lib parses the file, so a fake header will not do. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const data = {
  attendee: { fullName: 'Aishah binti Rahman', ticketCode: 'ORC-7K4Q', qrToken: 'a'.repeat(22) },
  registration: { contactName: 'Aishah binti Rahman' },
  player: null,
  show: {
    name: '19 Sep',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik',
    venueAddress: 'Kuala Lumpur',
  },
  concert: { name: 'September concert', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
};

const imageLayout = (src: string) => ({
  canvas: { width_pt: 200, height_pt: 100, dpi: 300 },
  elements: [
    {
      id: 'el_logo',
      type: 'IMAGE' as const,
      src,
      x: 10,
      y: 10,
      w: 40,
      h: 40,
      rotation: 0,
      opacity: 1,
    },
  ],
});

describe('IMAGE elements', () => {
  it('draws one when the store has the bytes', async () => {
    const path = await putAsset({
      concertId: 1,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1x1),
    });

    const result = await renderTicket({
      layout: imageLayout(path),
      data,
      loadAsset: loadTicketAsset,
    });

    expect(result.skipped).toEqual({});
    expect(result.pdf.byteLength).toBeGreaterThan(0);
  });

  it('says why when it cannot, rather than leaving a silent gap', async () => {
    // A silently missing element is indistinguishable from one that was never
    // there — the failure D's QA pass found.
    const noLoader = await renderTicket({ layout: imageLayout('concerts/1/a.png'), data });
    expect(noLoader.skipped.el_logo).toMatch(/loader/i);

    const missing = await renderTicket({
      layout: imageLayout('concerts/1/gone.png'),
      data,
      loadAsset: loadTicketAsset,
    });
    expect(missing.skipped.el_logo).toMatch(/nothing at/i);

    const pdfAsset = await putAsset({
      concertId: 1,
      contentType: 'application/pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    const wrongType = await renderTicket({
      layout: imageLayout(pdfAsset),
      data,
      loadAsset: loadTicketAsset,
    });
    expect(wrongType.skipped.el_logo).toMatch(/not a PNG or JPEG/i);
  });

  it('never fails the render over a decoration', async () => {
    // An unrenderable logo must not cost a guest their ticket.
    const result = await renderTicket({
      layout: imageLayout('concerts/1/gone.png'),
      data,
      loadAsset: loadTicketAsset,
    });
    expect(result.pdf.byteLength).toBeGreaterThan(0);
  });
});

describe('backgroundFor', () => {
  it('reads the kind from the stored asset', async () => {
    const png = await putAsset({
      concertId: 2,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1x1),
    });
    expect(await backgroundFor({ backgroundAssetPath: png, backgroundKind: 'IMAGE' })).toMatchObject(
      { kind: 'IMAGE', mime: 'image/png' },
    );

    const pdf = await putAsset({
      concertId: 2,
      contentType: 'application/pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    expect(await backgroundFor({ backgroundAssetPath: pdf, backgroundKind: 'PDF' })).toMatchObject({
      kind: 'PDF',
    });
  });

  it('falls back to no background rather than failing', async () => {
    // A lost file is a design problem; a guest at the door with no ticket is
    // not, so this degrades instead of throwing.
    expect(await backgroundFor({ backgroundAssetPath: null, backgroundKind: 'NONE' })).toEqual({
      kind: 'NONE',
    });
    expect(
      await backgroundFor({ backgroundAssetPath: 'concerts/2/gone.png', backgroundKind: 'IMAGE' }),
    ).toEqual({ kind: 'NONE' });
    expect(
      await backgroundFor({ backgroundAssetPath: '../escape.png', backgroundKind: 'IMAGE' }),
    ).toEqual({ kind: 'NONE' });
  });
});

describe('an issued ticket', () => {
  it('carries the artwork of the version it is pinned to', async () => {
    await resetDb();
    const concertId = await createConcert('Artwork');
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, { capacity: 10, audienceMode: 'PUBLIC' });
    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });

    await ensureConcertTemplates(concertId);
    const template = (await listTemplates(concertId)).find((t) => t.isDefault)!;
    const path = await putAsset({
      concertId,
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_1x1),
    });
    await sql`
      update ticket_templates
         set background_asset_path = ${path}, background_kind = 'IMAGE'
       where id = ${template.id}
    `;

    await issueTickets({ concertId, showId });
    const [attendee] = await sql<{ id: number }[]>`
      select id from attendees where show_id = ${showId} limit 1
    `;

    const ticket = await loadTicket(Number(attendee.id));
    expect(ticket?.template).toMatchObject({
      backgroundAssetPath: path,
      backgroundKind: 'IMAGE',
    });

    // And the renderer actually consumes it: a background makes the PDF
    // materially larger than the same layout on a blank page.
    const withArt = await renderTicket({
      layout: ticket!.template.layout,
      data: ticket!.data,
      background: await backgroundFor(ticket!.template),
      loadAsset: loadTicketAsset,
    });
    const without = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
    expect(withArt.pdf.byteLength).toBeGreaterThan(without.pdf.byteLength);
  });
});
