import { NextResponse } from 'next/server';
import { getAsset } from '@/lib/tickets/assets';
import { publishedBookletForShow, publishedBookletFile } from '@/lib/portal/booklet';
import { portalIsUnlocked } from '@/lib/portal/sections';
import { ticketStatus } from '@/lib/portal/status';

/**
 * `GET /api/portal/{token}/booklet` — the programme booklet, to a ticket holder
 * who has unlocked it (§13.3 item 2).
 *
 * **Every gate the section has, restated here.** The portal draws the viewer
 * only when the concert runs a portal, the guest has unlocked it, the show
 * enables the booklet section and a booklet is published — and a URL is not a
 * button, so the route asks all four again. A file route that trusts the page
 * not to have linked it is a file route with no access control at all: this is
 * the one asset in the system that must not leak before the concert.
 *
 * **The credential is the token**, as everywhere on this surface.
 *
 * Under `/api` because it reads from the asset store with `node:fs` on the local
 * backend, which needs the Node runtime.
 */
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  /** One 404 for every reason, as the page renders one message for every reason (§13.2). */
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

  const status = await ticketStatus(token);
  if (!status) return notFound();

  const unlocked = portalIsUnlocked({
    mode: status.portal.unlockMode,
    admitted: status.state === 'ADMITTED',
    cancelled: status.state === 'CANCELLED',
  });
  if (!unlocked || !status.portal.enabled || !status.portal.bookletEnabled) return notFound();

  const booklet = await publishedBookletForShow({
    showId: status.show.id,
    concertId: status.concertId,
  });
  if (!booklet) return notFound();

  const file = await publishedBookletFile({
    bookletId: booklet.id,
    showId: status.show.id,
    concertId: status.concertId,
  });
  if (!file) return notFound();

  const asset = await getAsset(file.pdfPath);
  /**
   * A published booklet whose bytes have gone is a 404 rather than a 500. The
   * guest can do nothing with either, and the row pointing at a missing object
   * is an admin problem that the audience should not meet as a crash.
   */
  if (!asset) return notFound();

  const body = Buffer.from(asset.bytes);
  const filename = `${file.title.replace(/[^\w\s.-]/g, '').trim() || 'programme'}.pdf`;

  /**
   * **Range requests, because this is the egress ceiling** (decision 13,
   * spec/platform.md §17.2). It is the one asset downloaded at audience scale,
   * and a phone's PDF viewer seeks rather than reading front to back — served
   * without `206` it re-fetches the whole file to turn a page, on venue wifi,
   * for four hundred people at once.
   */
  const range = parseRange(request.headers.get('range'), body.byteLength);
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'content-disposition': `${
      new URL(request.url).searchParams.get('download') ? 'attachment' : 'inline'
    }; filename="${filename}"`,
    'accept-ranges': 'bytes',
    /**
     * Private, but cacheable on the device: the booklet is the same bytes for
     * everyone who can see it and re-downloading it is the cost this header
     * exists to avoid. Never `public` — a shared proxy holding it would serve it
     * to someone with no token.
     */
    'cache-control': 'private, max-age=3600',
    'x-robots-tag': 'noindex, nofollow',
  };

  if (range) {
    return new NextResponse(body.subarray(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${body.byteLength}`,
      },
    });
  }

  return new NextResponse(body, { headers });
}

/**
 * A single `bytes=` range, or null for "send the whole thing".
 *
 * Deliberately narrow: one range, no multipart, and any header this does not
 * understand falls back to a `200` with the complete file. A viewer that asked
 * for something exotic gets more than it wanted rather than an error, which is
 * the right failure for a document somebody is trying to read.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  /** `bytes=-500` — the last 500 bytes, which is how a PDF viewer finds the trailer. */
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;

  return { start, end };
}
