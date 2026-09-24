import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { booklets } from '@/db/schema/booklets';
import { writeAuditLog } from '@/lib/audit';
import { getSessionUser } from '@/lib/auth/session';
import { MAX_ASSET_BYTES, tooLargeMessage } from '@/lib/tickets/asset-limits';
import { putAsset, sniffContentType } from '@/lib/tickets/assets';

/**
 * `POST /api/portal/booklet` — upload a programme booklet (§13.3 item 2).
 *
 * A Route Handler rather than a Server Action because the payload is a file:
 * Server Actions cap a request body well below what a programme PDF reaches,
 * and the cap is not configurable per action. Module `D`'s
 * `/api/ticket-assets` made the same call for the same reason, and this reuses
 * its store rather than opening a second one — `booklets.pdf_path` holds the
 * same opaque key, so a booklet row does not record where its bytes live.
 *
 * **`/api` is outside the proxy matcher, so this route is unprotected until it
 * checks for itself** (modules.md §5.2.1). Admins only: an operator may not edit
 * any data at all (spec/admin.md §14.1).
 *
 * **Uploaded unpublished, always.** `booklets.published` defaults false and this
 * route never sets it. Publishing is a separate, deliberate action because it is
 * the moment the programme becomes visible to everyone holding a ticket, and an
 * upload that published itself would make "put it up early and release it on the
 * day" — the reason the flag exists — impossible to do safely.
 */
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a multipart upload.' }, { status: 400 });
  }

  const concertId = Number(form.get('concertId'));
  if (!Number.isInteger(concertId) || concertId <= 0) {
    return NextResponse.json({ error: 'Which concert is this for?' }, { status: 400 });
  }

  /**
   * Blank means the booklet covers the whole concert rather than one night,
   * which is what `booklets.show_id` being nullable is for — the common case
   * for a concert whose shows share a programme.
   */
  const rawShowId = form.get('showId');
  const showId = rawShowId === null || rawShowId === '' ? null : Number(rawShowId);
  if (showId !== null && (!Number.isInteger(showId) || showId <= 0)) {
    return NextResponse.json({ error: 'That is not a show.' }, { status: 400 });
  }

  const title = String(form.get('title') ?? '').trim();
  if (!title) return NextResponse.json({ error: 'Give the booklet a title.' }, { status: 400 });

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
  }
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: tooLargeMessage(file.size) }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /**
   * The file's own bytes decide, never `file.type`. A booklet that is not a PDF
   * reaches four hundred phones as a document none of them can open, and the
   * first report of it is a guest in a dark hall.
   */
  const contentType = sniffContentType(bytes);
  if (contentType !== 'application/pdf') {
    return NextResponse.json({ error: 'A booklet must be a PDF.' }, { status: 415 });
  }

  let pdfPath: string;
  try {
    pdfPath = await putAsset({ concertId, contentType, bytes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not store the booklet.' },
      { status: 500 },
    );
  }

  const [row] = await getDb()
    .insert(booklets)
    .values({ concertId, showId, title, pdfPath })
    .returning({ id: booklets.id });

  await writeAuditLog({
    action: 'booklet.uploaded',
    entityType: 'booklets',
    entityId: row.id,
    after: { title, showId, pdfPath },
  });

  return NextResponse.json({ id: row.id });
}

/**
 * `PATCH /api/portal/booklet` — publish or unpublish.
 *
 * On the same route as the upload because it is the same resource and the same
 * admin gate, and because publishing is the only thing that can be done to a
 * booklet after it exists.
 */
export async function PATCH(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; published?: unknown }
    | null;
  const id = Number(body?.id);
  const published = body?.published;
  if (!Number.isInteger(id) || id <= 0 || typeof published !== 'boolean') {
    return NextResponse.json({ error: 'Expected an id and a published flag.' }, { status: 400 });
  }

  const [row] = await getDb()
    .update(booklets)
    .set({ published })
    .where(eq(booklets.id, id))
    .returning({ id: booklets.id, title: booklets.title });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await writeAuditLog({
    /**
     * Publishing is the moment a programme becomes visible to everyone holding
     * a ticket, and unpublishing is the moment it stops. Both are worth a row:
     * "when did this go up?" is the first question after it goes up early.
     */
    action: published ? 'booklet.published' : 'booklet.unpublished',
    entityType: 'booklets',
    entityId: row.id,
    after: { published },
  });

  return NextResponse.json({ ok: true });
}
