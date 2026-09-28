import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { SUPABASE_URL } from '@/lib/supabase/public-env';
import { MAX_ASSET_BYTES } from '@/lib/tickets/asset-limits';

/**
 * A form's banner image (spec/v3.md §25.6).
 *
 * **A public bucket, `form-assets`.** `ticket-assets` is private — ticket
 * artwork is read by the renderer with the service role — but a banner is
 * shown to anyone who opens the form, so it is served straight from the
 * bucket's public URL and the form page never proxies it. The bucket is made
 * by hand (`docs/local.md` §16).
 *
 * As with ticket artwork, `FORM_ASSET_DIR` switches to a local directory for
 * development and tests, served by `/api/form-banners/{path}`.
 */

export const BANNER_BUCKET = 'form-assets';

const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;
export type BannerType = keyof typeof TYPES;

/** From the bytes, never the upload's claimed type. */
export function sniffBannerType(bytes: Uint8Array): BannerType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

export function bannerContentType(path: string): BannerType | null {
  const ext = path.split('.').pop()?.toLowerCase();
  const found = Object.entries(TYPES).find(([, e]) => e === ext);
  return found ? (found[0] as BannerType) : null;
}

function localRoot(): string | null {
  const dir = process.env.FORM_ASSET_DIR;
  return dir ? resolve(dir) : null;
}

function localFile(root: string, path: string): string {
  const full = resolve(join(root, normalize(path)));
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`Banner path escapes its directory: ${path}`);
  return full;
}

export async function putBanner(formId: number, bytes: Uint8Array): Promise<{ path: string; contentType: BannerType }> {
  if (bytes.byteLength === 0) throw new Error('The image is empty.');
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('The image is too large.');
  const contentType = sniffBannerType(bytes);
  if (!contentType) throw new Error('Use a PNG, JPEG or WebP image.');
  const path = `forms/${formId}/${randomUUID()}.${TYPES[contentType]}`;

  const root = localRoot();
  if (root) {
    const file = localFile(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { path, contentType };
  }
  const { error } = await createSupabaseAdminClient()
    .storage.from(BANNER_BUCKET)
    .upload(path, bytes, { contentType, upsert: false, cacheControl: '31536000' });
  if (error) throw new Error(`Could not store the banner: ${error.message}`);
  return { path, contentType };
}

/** Local backend only: the bytes, for `/api/form-banners`. */
export async function readLocalBanner(path: string): Promise<Uint8Array | null> {
  const root = localRoot();
  if (!root || !bannerContentType(path)) return null;
  try {
    return new Uint8Array(await readFile(localFile(root, path)));
  } catch {
    return null;
  }
}

export async function deleteBanner(path: string): Promise<void> {
  const root = localRoot();
  if (root) {
    await unlink(localFile(root, path)).catch(() => undefined);
    return;
  }
  await createSupabaseAdminClient().storage.from(BANNER_BUCKET).remove([path]);
}

/**
 * Where a browser loads the banner from. Paths are written only by
 * {@link putBanner} (a uuid under `forms/{id}/`), so they need no escaping
 * beyond what `parseTheme` already refused.
 */
export function bannerUrl(path: string): string {
  if (localRoot()) return `/api/form-banners/${path}`;
  return `${SUPABASE_URL ?? ''}/storage/v1/object/public/${BANNER_BUCKET}/${path}`;
}
