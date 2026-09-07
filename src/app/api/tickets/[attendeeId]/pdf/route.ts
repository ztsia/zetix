import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { canAccessShow } from '@/lib/auth/show-access';
import { loadTicket } from '@/lib/tickets/load';
import { renderTicket } from '@/lib/tickets/render';

/**
 * `GET /api/tickets/{attendeeId}/pdf` — one rendered ticket.
 *
 * **A Route Handler rather than a Server Action, and it has to live under
 * `/api`.** `next.config.ts` traces `src/assets/fonts/**` into `/api/**` only;
 * a render reached from anywhere else would find no font files, and would fail
 * in production alone, in the ticket path, on the day tickets go out.
 *
 * `runtime = 'nodejs'` because pdf-lib and the font reads are Node work
 * (CLAUDE.md).
 *
 * **`/api` is excluded from the proxy matcher, so this route is unprotected
 * until it checks for itself** (modules.md §5.2.1). It carries an attendee's
 * name and their show — less than the manifest, but not public — so it verifies
 * the session and then the show scope, exactly as `G` and `H` must.
 */
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attendeeId: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const { attendeeId: raw } = await params;
  const attendeeId = Number(raw);
  if (!Number.isInteger(attendeeId) || attendeeId <= 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const ticket = await loadTicket(attendeeId);
  /**
   * 404, never 403, and the same 404 for "no such attendee", "not yet issued"
   * and "not your show". Probing ids must not be able to tell those apart —
   * the same rule the scanner's per-show route follows (modules.md §5.2.1).
   */
  if (!ticket) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!(await canAccessShow(user, ticket.showId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { pdf } = await renderTicket({
    layout: ticket.template.layout,
    data: ticket.data,
  });

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'content-type': 'application/pdf',
      // `inline` so a preview opens in the browser instead of downloading; the
      // admin screen adds `?download=1` when it wants a file.
      'content-disposition': `inline; filename="${ticket.filename}"`,
      // Rendered on demand and pinned to a template version, so it is stable
      // for a given attendee — but it carries a name, so it must never be
      // cached by a shared proxy.
      'cache-control': 'private, no-store',
    },
  });
}
