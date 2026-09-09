import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { getAsset } from '@/lib/tickets/assets';
import { layoutSchema } from '@/lib/tickets/layout';
import { previewTicketData } from '@/lib/tickets/preview';
import { renderTicket, type Background } from '@/lib/tickets/render';

/**
 * `POST /api/tickets/preview` — render an **unsaved** layout to a PDF
 * (spec/tickets.md §10.3).
 *
 * The canvas is an approximation: it measures text with whatever fonts the
 * browser has, and the renderer measures it with the embedded ones. For "does
 * this design look right" that is fine. For "does the longest name in this show
 * overflow its box" it is not — and that question is the reason §10.3 asks for
 * the longest-name preview at all, because the alternative is finding out at
 * four hundred tickets.
 *
 * So this route answers it with the real renderer, and reports what it had to
 * clip. Nothing is written: the layout comes from the editor's current state,
 * not from the database, so an admin can check before saving.
 *
 * **It has to live under `/api`.** `next.config.ts` traces `src/assets/fonts/**`
 * into `/api/**` only; a render reached from anywhere else finds no fonts and
 * fails in production alone, in the ticket path (module `D`'s handoff).
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

const bodySchema = z.object({
  concertId: z.number().int().positive(),
  showId: z.number().int().positive(),
  subject: z.enum(['FIRST', 'LONGEST_NAME', 'SAMPLE']),
  attendeeId: z.number().int().positive().nullable().optional(),
  layout: layoutSchema,
  backgroundAssetPath: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  /**
   * **Admins only**, for the same reason the ticket PDF route is: a rendered
   * ticket carries an attendee's name, show and venue, and an operator may not
   * view PII beyond name and ticket status (spec/admin.md §14.1).
   */
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Malformed request.' },
      { status: 400 },
    );
  }

  const data = await previewTicketData(parsed.data);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let background: Background = { kind: 'NONE' };
  if (parsed.data.backgroundAssetPath) {
    const asset = await getAsset(parsed.data.backgroundAssetPath).catch(() => null);
    if (asset) {
      background =
        asset.contentType === 'application/pdf'
          ? { kind: 'PDF', bytes: asset.bytes }
          : { kind: 'IMAGE', bytes: asset.bytes, mime: asset.contentType };
    }
  }

  const { pdf, truncated, skipped } = await renderTicket({
    layout: parsed.data.layout,
    data,
    background,
    loadAsset: (path) => getAsset(path).catch(() => null),
  });

  /**
   * The findings ride in headers so the body stays a PDF the browser can open
   * in a tab. Both are short lists of element ids; a layout with enough
   * elements to overflow a header has other problems.
   */
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
