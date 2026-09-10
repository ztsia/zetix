import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import { MAX_ASSET_BYTES, tooLargeMessage } from '@/lib/tickets/asset-limits';
import { assetKind, putAsset, sniffContentType } from '@/lib/tickets/assets';

/**
 * `POST /api/ticket-assets` — upload a template background or decoration
 * (spec/tickets.md §10.3).
 *
 * A Route Handler rather than a Server Action because the payload is a file:
 * Server Actions cap a request body far below the 4 MB an A4 photograph reaches,
 * and the cap is not configurable per action.
 *
 * Node runtime — the store writes with `node:fs` under `TICKET_ASSET_DIR`.
 *
 * **`/api` is outside the proxy matcher, so this route is unprotected until it
 * checks for itself** (modules.md §5.2.1). Admins only: an operator may not edit
 * any data at all (spec/admin.md §14.1).
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

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
  }
  // The editor checks this before sending, so reaching here means a caller that
  // is not the editor — or one running older code. Kept because the limit is
  // what stops the *platform* rejecting the body instead, and that failure has
  // no message in it (see `asset-limits.ts`).
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: tooLargeMessage(file.size) }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /**
   * The file's own bytes decide, never `file.type` — see `sniffContentType`.
   * A mistyped upload accepted here becomes a render failure on every ticket in
   * the show, with nothing pointing back at this moment.
   */
  const contentType = sniffContentType(bytes);
  if (!contentType) {
    return NextResponse.json(
      { error: 'Only PNG, JPEG and PDF artwork can be used on a ticket.' },
      { status: 415 },
    );
  }

  let path: string;
  try {
    path = await putAsset({ concertId, contentType, bytes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The upload could not be stored.' },
      { status: 500 },
    );
  }

  await writeAuditLog({
    action: 'ticket_asset.uploaded',
    entityType: 'concert',
    entityId: concertId,
    after: { path, contentType, bytes: bytes.byteLength },
  });

  return NextResponse.json({
    path,
    contentType,
    kind: assetKind(contentType),
    bytes: bytes.byteLength,
  });
}
