import 'server-only';

import { PDFDocument } from 'pdf-lib';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { backgroundFor, loadTicketAsset } from '@/lib/tickets/background';
import { loadTicket } from '@/lib/tickets/load';
import { renderTicket } from '@/lib/tickets/render';
import type { OutgoingAttachment } from './transport';

/**
 * Turning a registration into the PDFs its message carries
 * (spec/email.md §11.3, decision 31).
 *
 * **Every confirmed seat in the party, not only the undelivered ones.** §11.4's
 * added-guest case is explicit: a party that gains a fourth guest receives one
 * message containing all four tickets, because "the party gets one email
 * containing everything they hold". The stamping in `dispatch.ts` then covers
 * exactly this set.
 */

export type PartyAttachments = {
  attendeeIds: number[];
  attachments: OutgoingAttachment[];
  /** Elements clipped or undrawable, surfaced so a blast is not silently wrong. */
  truncated: string[];
  skipped: string[];
};

export class UnissuedTicketError extends Error {
  constructor(readonly attendeeIds: number[]) {
    super(
      `${attendeeIds.length} seat(s) in this party have no issued ticket, so there is ` +
        'nothing to attach. Issue tickets for the show before blasting ' +
        '(spec/tickets.md §10.5).',
    );
    this.name = 'UnissuedTicketError';
  }
}

async function confirmedAttendeeIds(registrationId: number): Promise<number[]> {
  const rows = await getDb().execute<{ id: string }>(sql`
    select a.id from attendees a
     where a.registration_id = ${registrationId}
       and a.status = 'CONFIRMED'
       and a.deleted_at is null
     order by a.id
  `);
  return rows.map((r) => Number(r.id));
}

/**
 * Merges many one-page tickets into a single PDF, past
 * `email.merge_attachments_above`.
 *
 * **Font programs are the reason this is worth doing.** Module `D` embeds fonts
 * with `subset: false` — load-bearing, and not to be reclaimed: pdf-lib's
 * subsetter produces a structurally perfect PDF whose glyphs do not render.
 * That costs roughly 400KB a ticket, so a large party carries the same font
 * program many times over. `copyPages` writes each font once into the merged
 * document.
 */
export async function mergePdfs(pdfs: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const bytes of pdfs) {
    const source = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return merged.save();
}

export async function buildPartyAttachments(opts: {
  registrationId: number;
  mergeAbove: number;
}): Promise<PartyAttachments> {
  const attendeeIds = await confirmedAttendeeIds(opts.registrationId);

  const rendered: { filename: string; pdf: Uint8Array }[] = [];
  const truncated: string[] = [];
  const skipped: string[] = [];
  const unissued: number[] = [];

  for (const attendeeId of attendeeIds) {
    const ticket = await loadTicket(attendeeId);
    /**
     * `loadTicket()` returns null for an attendee with no pinned template — an
     * unissued ticket. Sending the party a message with a seat missing from it
     * is worse than not sending: they would arrive at the door believing they
     * hold four tickets.
     */
    if (!ticket) {
      unissued.push(attendeeId);
      continue;
    }

    const result = await renderTicket({
      layout: ticket.template.layout,
      data: ticket.data,
      // Both are required or every ticket prints without its artwork (module E).
      background: await backgroundFor(ticket.template),
      loadAsset: loadTicketAsset,
    });

    truncated.push(...result.truncated);
    skipped.push(...Object.entries(result.skipped).map(([id, why]) => `${id}: ${why}`));
    rendered.push({ filename: ticket.filename, pdf: result.pdf });
  }

  if (unissued.length > 0) throw new UnissuedTicketError(unissued);

  const attachments: OutgoingAttachment[] =
    rendered.length > opts.mergeAbove
      ? [
          {
            filename: `tickets-${opts.registrationId}.pdf`,
            content: await mergePdfs(rendered.map((r) => r.pdf)),
            contentType: 'application/pdf',
          },
        ]
      : rendered.map((r) => ({
          filename: r.filename,
          content: r.pdf,
          contentType: 'application/pdf',
        }));

  return { attendeeIds, attachments, truncated, skipped };
}

/**
 * Gmail's ceiling is 25MB and it applies to the **encoded** message, not the
 * files.
 *
 * Base64 inflates by a measured ×1.368 — 20MB of PDFs is 27.4MB on the wire and
 * Gmail refuses it — so `email.max_attachment_mb` is compared against the
 * encoded size here rather than the raw one. Reading the setting as raw bytes
 * would let a 20MB cap produce a message no provider will take.
 */
export const BASE64_INFLATION = 4 / 3;

export function encodedSizeBytes(attachments: OutgoingAttachment[]): number {
  const raw = attachments.reduce((total, a) => total + a.content.byteLength, 0);
  return Math.ceil(raw * BASE64_INFLATION);
}
