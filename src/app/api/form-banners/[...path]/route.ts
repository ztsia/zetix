import { bannerContentType, readLocalBanner } from '@/lib/forms/banner';

/**
 * `GET /api/form-banners/{path}` — a banner from the **local** backend
 * (`FORM_ASSET_DIR`), for development and tests. In production banners are
 * served from the public `form-assets` bucket directly and this answers 404.
 * Public, as the form it decorates is.
 */

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const joined = (path ?? []).join('/');
  const type = bannerContentType(joined);
  const bytes = type && !joined.includes('..') ? await readLocalBanner(joined) : null;
  if (!bytes || !type) return new Response('Not found', { status: 404 });
  return new Response(Buffer.from(bytes), {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' },
  });
}
