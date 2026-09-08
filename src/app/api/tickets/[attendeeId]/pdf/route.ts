import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { canAccessShow } from '@/lib/auth/show-access';
import { backgroundFor, loadTicketAsset } from '@/lib/tickets/background';
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

/**
 * A render is bounded work, but not instant: the fonts are embedded whole and a
 * hostile name makes the text fitter do real work. 30s leaves a wide margin
 * over a normal ticket (tens of milliseconds) while still failing visibly
 * rather than hanging a Vercel function to its platform default.
 */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attendeeId: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  /**
   * **Admins only.** `admin.md` §14.1: an operator "cannot edit any data,
   * export, view PII beyond name and ticket status". A rendered ticket is a
   * downloadable file carrying the attendee's name, show, venue and doors —
   * an export in everything but name. The door does not need it either: the
   * scanner matches `qr_token` against the offline manifest and never
   * dereferences the QR (decision 28).
   */
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
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
    // The artwork of the **pinned** version, not of the template's newest one
    // (§10.5) — `loadTicket()` carries it for exactly that reason.
    background: await backgroundFor(ticket.template),
    loadAsset: loadTicketAsset,
  });

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'content-type': 'application/pdf',
      // `inline` previews in the browser; `?download=1` saves a file. The
      // screen's two row actions are exactly these, and the parameter used to
      // be documented here while nothing read it — so both buttons previewed.
      'content-disposition': `${
        new URL(request.url).searchParams.get('download') ? 'attachment' : 'inline'
      }; filename="${ticket.filename}"`,
      // Rendered on demand and pinned to a template version, so it is stable
      // for a given attendee — but it carries a name, so it must never be
      // cached by a shared proxy.
      'cache-control': 'private, no-store',
    },
  });
}
