import { NextResponse } from 'next/server';
import { backgroundFor, loadTicketAsset } from '@/lib/tickets/background';
import { loadTicket } from '@/lib/tickets/load';
import { renderTicket } from '@/lib/tickets/render';
import { attendeeIdForToken, isTokenShaped, ticketStatus } from '@/lib/portal/status';

/**
 * `GET /api/portal/{token}/ticket` — the holder's own ticket PDF (§13.3 item 1).
 *
 * **The credential is the token, and that is the whole of it.** This is the same
 * authorization story as the page the button sits on: 128 bits of CSPRNG
 * entropy naming exactly one row, with no session and no way to widen to a
 * second attendee. `/api/tickets/{attendeeId}/pdf` exists for admins and is
 * admin-only for a good reason — it takes an *id*, which anyone can count
 * upwards — so it cannot be the one a guest presses.
 *
 * **Under `/api` because it renders**, not by convention: `next.config.ts`
 * traces `src/assets/fonts/**` into `/api/**` only, and a render reached from
 * anywhere else finds no fonts and fails in production alone, in the ticket
 * path, on the day tickets go out. Module `D` recorded that trap; this is the
 * second route to inherit it.
 *
 * **The PDF is the ticket** (§13.1). The portal is additive, so this route
 * existing or not cannot affect admission — the scanner works from its offline
 * manifest and never dereferences the QR (decision 28).
 */
export const runtime = 'nodejs';

/** Module `D`'s own ceiling for one render, for the same reasons. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  /**
   * **One 404 for every reason**, exactly as the page renders one "no such
   * ticket" for all three of its (§13.2). A wrong guess and a near miss must
   * cost the same, and a cancelled party must not be able to tell from a
   * download that their seats were real.
   *
   * **A page, never JSON** (spec/v3.md §32.3). A person pressed a button and a
   * browser tab opened; `{"error":"Not found"}` is not an answer they can use.
   */
  const notFound = () => unavailablePage(token);

  const status = await ticketStatus(token);
  if (!status) return notFound();

  /**
   * A cancelled ticket does not render. §13.2 replaces the whole ticket card
   * with "no longer valid — please see the front desk", and handing that same
   * holder a clean PDF would contradict the page they pressed the button on and
   * put a scannable-looking document in the hands of someone the door will
   * turn away.
   */
  if (status.state === 'CANCELLED') return notFound();
  /** On hold: the door refuses it, so this route does not hand out a PDF that looks valid. */
  if (status.state === 'ON_HOLD') return notFound();

  const attendeeId = await attendeeIdForToken(token);
  if (attendeeId === null) return notFound();

  const ticket = await loadTicket(attendeeId);
  /** Not yet issued — no template pinned, nothing to draw. */
  if (!ticket) return notFound();

  const { pdf } = await renderTicket({
    layout: ticket.template.layout,
    data: ticket.data,
    /**
     * The artwork of the **pinned** version (§10.5). A template edit must never
     * change a ticket someone already holds, and a guest re-downloading the PDF
     * they were emailed must get that PDF, not a newer design.
     */
    background: await backgroundFor(ticket.template),
    loadAsset: loadTicketAsset,
  });

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${
        new URL(request.url).searchParams.get('download') ? 'attachment' : 'inline'
      }; filename="${ticket.filename}"`,
      /**
       * Carries a name, so no shared cache may hold it — and `no-store` rather
       * than a private max-age because cancellation is the one thing that must
       * not be served from a phone's disk after the fact.
       */
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/**
 * The answer a guest gets when there is no PDF to give them.
 *
 * Self-contained HTML rather than a rendered route, because this is the
 * render route's failure path and must not depend on anything that could be
 * the reason for the failure. It follows the device's dark mode, like the page
 * the button sat on, and points back to that page — which says, in the guest's
 * own words, why there is nothing to download yet.
 */
function unavailablePage(token: string): NextResponse {
  const back = isTokenShaped(token)
    ? `<p><a href="/t/${token}">Back to your ticket page</a></p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Ticket not available</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; display: flex; justify-content: center; }
  main { max-width: 28rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  a { display: inline-block; min-height: 44px; line-height: 44px; }
</style>
</head>
<body>
<main>
<h1>This ticket isn&rsquo;t available to download</h1>
<p>It may not have been issued yet, or it may no longer be valid. Your ticket page says which, and the front desk can find you by name on the night.</p>
${back}
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
