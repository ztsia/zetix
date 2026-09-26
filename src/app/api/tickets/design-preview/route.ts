import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { backgroundFor, loadTicketAsset } from '@/lib/tickets/background';
import { previewTicketData } from '@/lib/tickets/preview';
import { renderTicket } from '@/lib/tickets/render';
import { loadTemplate } from '@/lib/tickets/templates';

/**
 * `GET /api/tickets/design-preview` — a **saved** ticket design rendered for
 * one seat, for the send wizard's design step (spec/v3.md §24.1): "a real
 * rendered PDF preview of the longest name in the selection".
 *
 * The real renderer, so a name that overflows its box is found here rather
 * than in four hundred inboxes; the clipped elements ride in a header, as
 * `/api/tickets/preview` does. Nothing is issued or pinned — the seat's token
 * may not exist yet, and the preview stands in for it.
 *
 * Under `/api` for the fonts (`next.config.ts` traces them into `/api/**`).
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

const querySchema = z.object({
  concertId: z.coerce.number().int().positive(),
  designId: z.coerce.number().int().positive(),
  attendeeId: z.coerce.number().int().positive().optional(),
});

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  // A rendered ticket carries a guest's name and a scannable code: admins only,
  // as for every other ticket render (spec/admin.md §14.1, v3 §28).
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  const { concertId, designId, attendeeId } = parsed.data;

  const template = await loadTemplate(concertId, designId);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The seat's show, checked against the concert rather than trusted.
  const [seat] = attendeeId
    ? await getDb().execute<{ show_id: string }>(sql`
        select a.show_id from attendees a join shows s on s.id = a.show_id
         where a.id = ${attendeeId} and s.concert_id = ${concertId}`)
    : await getDb().execute<{ show_id: string }>(sql`
        select id as show_id from shows where concert_id = ${concertId} and deleted_at is null
         order by id limit 1`);
  if (!seat) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const data = await previewTicketData({
    concertId,
    showId: Number(seat.show_id),
    subject: attendeeId ? 'LONGEST_NAME' : 'SAMPLE',
    attendeeId: attendeeId ?? null,
  });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { pdf, truncated, skipped } = await renderTicket({
    layout: template.layout,
    data,
    background: await backgroundFor(template),
    loadAsset: loadTicketAsset,
  });

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="preview.pdf"',
      'x-ticket-truncated': JSON.stringify(truncated),
      'x-ticket-skipped': JSON.stringify(Object.keys(skipped)),
      'cache-control': 'private, no-store',
    },
  });
}
