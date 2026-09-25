import { NextResponse } from 'next/server';
import { hasRole } from '@/lib/auth/guards';
import { getSessionUser } from '@/lib/auth/session';
import { assetEtag, getAsset } from '@/lib/tickets/assets';

/**
 * `GET /api/ticket-assets/{path}` — the stored artwork, for the editor canvas.
 *
 * The editor draws the background on a Konva stage, so it needs the bytes over
 * HTTP. Neither backend can serve them directly: the local directory is not
 * inside `public/`, and the Supabase bucket is private.
 *
 * **Admins and viewers only.** A viewer reads the template editor (spec/v3.md
 * §28), and artwork holds no attendee's details; an operator has no reason to
 * see it. The path is a random UUID and therefore unguessable, but
 * "unguessable" is not an authorization check, and the same 404 answers "no such asset" and "not signed in" so probing
 * cannot tell them apart.
 */
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const user = await getSessionUser();
  if (!hasRole(user, 'ADMIN', 'VIEWER')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { path: segments } = await params;
  const path = segments.join('/');

  const asset = await getAsset(path).catch(() => null);
  if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return new NextResponse(Buffer.from(asset.bytes), {
    headers: {
      'content-type': asset.contentType,
      etag: assetEtag(asset.bytes),
      // A path's bytes never change — it is written once under a random name —
      // but the artwork is not public, so only the viewer's own browser may
      // keep it.
      'cache-control': 'private, max-age=3600',
    },
  });
}
