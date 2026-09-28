import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { getSessionUser } from '@/lib/auth/session';
import { deleteBanner, putBanner } from '@/lib/forms/banner';
import { isHexColour, parseTheme } from '@/lib/forms/theme';
import { MAX_ASSET_BYTES, tooLargeMessage } from '@/lib/tickets/asset-limits';

/**
 * `POST /api/form-banners` — upload a form's banner (spec/v3.md §25.6).
 *
 * A Route Handler rather than a Server Action because an image is larger than
 * a Server Action's default body limit, as ticket artwork is
 * (`/api/ticket-assets`). The colour is taken from the image in the browser
 * (a canvas average, `form-theme.tsx`) and sent with it — the input of an
 * admin, checked for contrast wherever it is used, and overridable. The
 * previous banner is removed from storage after the new one is saved.
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
  const formId = Number(form.get('formId'));
  if (!Number.isSafeInteger(concertId) || concertId <= 0 || !Number.isSafeInteger(formId) || formId <= 0) {
    return NextResponse.json({ error: 'Which form is this for?' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
  if (file.size > MAX_ASSET_BYTES) return NextResponse.json({ error: tooLargeMessage(file.size) }, { status: 413 });

  const db = getDb();
  const [row] = await db.execute<{ theme: unknown }>(sql`
    select f.theme from registration_forms f
      left join show_segments g on g.id = f.segment_id
      join shows s on s.id = coalesce(f.show_id, g.show_id)
     where f.id = ${formId} and s.concert_id = ${concertId} and f.deleted_at is null
  `);
  if (!row) return NextResponse.json({ error: 'That form no longer exists.' }, { status: 404 });

  const sent = form.get('colour');
  const colour = typeof sent === 'string' && isHexColour(sent) ? sent.toLowerCase() : null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  let path: string;
  try {
    ({ path } = await putBanner(formId, bytes));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The banner could not be stored.' },
      { status: 415 },
    );
  }

  const previous = parseTheme(row.theme);
  const theme = { bannerPath: path, colour, colourOverride: previous?.colourOverride ?? null };
  await db.execute(sql`
    update registration_forms set theme = ${JSON.stringify(theme)}::jsonb, updated_at = now() where id = ${formId}
  `);
  if (previous?.bannerPath && previous.bannerPath !== path) await deleteBanner(previous.bannerPath);
  await writeAuditLog({
    action: 'form.banner_uploaded',
    entityType: 'registration_form',
    entityId: formId,
    after: { path, colour },
  });
  return NextResponse.json({ theme });
}
