import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MAX_ASSET_BYTES } from './asset-limits';

/**
 * Where a template's artwork lives (spec/tickets.md §10.3).
 *
 * Module `D` left this gap deliberately: its renderer already accepts a
 * background and draws `IMAGE` elements, but nothing could hand it bytes because
 * no asset store existed. This is that store.
 *
 * **Two backends behind one path string.** `ticket_templates.background_asset_path`
 * holds the same opaque key whichever backend wrote it, so a template row does
 * not record where its bytes happen to live:
 *
 *  - **Supabase Storage** in production — the private `ticket-assets` bucket
 *    (`docs/local.md` §8).
 *  - **A local directory** in development, tests and CI, chosen by setting
 *    `TICKET_ASSET_DIR`.
 *
 * The local backend is not a convenience. There is no network route from a cloud
 * container to a Supabase bucket's contents and no service-role key in one
 * (`docs/local.md` §7), so without it upload, fetch and background rendering
 * would all be untestable — and the failure would first appear on the day
 * tickets go out.
 */

/** The private bucket the Supabase backend writes to. */
export const ASSET_BUCKET = 'ticket-assets';

/**
 * What §10.3 allows to be uploaded: "PNG/JPG, or PDF page 1".
 *
 * The list is closed and checked against the file's own leading bytes rather
 * than its name or its declared type, both of which the browser takes from the
 * client. `pdf-lib` embeds exactly PNG and JPEG, so anything else reaches the
 * renderer as an artwork that silently fails to draw.
 */
export const ASSET_TYPES = {
  'image/png': { ext: 'png', kind: 'IMAGE' },
  'image/jpeg': { ext: 'jpg', kind: 'IMAGE' },
  'application/pdf': { ext: 'pdf', kind: 'PDF' },
} as const satisfies Record<string, { ext: string; kind: 'IMAGE' | 'PDF' }>;

export type AssetContentType = keyof typeof ASSET_TYPES;
export type AssetKind = (typeof ASSET_TYPES)[AssetContentType]['kind'];

export function isAssetContentType(value: string): value is AssetContentType {
  return value in ASSET_TYPES;
}

/**
 * Re-exported so the server side of this module keeps its single import, while
 * the editor can reach the same number without pulling `node:fs` in with it.
 */
export { MAX_ASSET_BYTES, formatBytes, tooLargeMessage } from './asset-limits';

export type StoredAsset = {
  path: string;
  contentType: AssetContentType;
  bytes: Uint8Array;
};

/**
 * The content type a file's own bytes claim to be.
 *
 * A browser's `File.type` comes from the operating system's idea of the
 * extension, so an admin who renames `notes.txt` to `artwork.png` uploads a
 * text file typed `image/png`. pdf-lib would then throw deep inside the render
 * of every ticket in the show rather than at the upload that caused it.
 */
export function sniffContentType(bytes: Uint8Array): AssetContentType | null {
  const startsWith = (...signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  return null;
}

/** `IMAGE` or `PDF` for a content type — `ticket_templates.background_kind`. */
export function assetKind(contentType: AssetContentType): AssetKind {
  return ASSET_TYPES[contentType].kind;
}

/** The content type a stored path implies, from the extension this module wrote. */
export function contentTypeOf(path: string): AssetContentType | null {
  const ext = path.split('.').pop()?.toLowerCase();
  for (const [type, meta] of Object.entries(ASSET_TYPES)) {
    if (meta.ext === ext) return type as AssetContentType;
  }
  return null;
}

/**
 * `concerts/{id}/{uuid}.{ext}` — flat, opaque and never derived from a filename.
 *
 * The uploaded name is not in the path on purpose. It would put an admin's
 * choice of characters into a URL and a filesystem path, and it would make two
 * uploads of `ticket.png` collide — quietly replacing the artwork of a template
 * that may already have issued tickets against it.
 */
function assetPath(concertId: number, contentType: AssetContentType): string {
  return `concerts/${concertId}/${randomUUID()}.${ASSET_TYPES[contentType].ext}`;
}

/** Set to switch to the filesystem backend. Absent means Supabase Storage. */
function localRoot(): string | null {
  const dir = process.env.TICKET_ASSET_DIR;
  return dir ? resolve(dir) : null;
}

/**
 * A path from the database, resolved under the local root and proved to still
 * be under it.
 *
 * `background_asset_path` is written by this module, but it arrives back here
 * out of a jsonb-adjacent text column that an admin action could in principle
 * set. `../` in it would otherwise read any file the server can reach.
 */
function localFile(root: string, path: string): string {
  const full = resolve(join(root, normalize(path)));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Asset path escapes the asset directory: ${path}`);
  }
  return full;
}

/**
 * Store bytes and return the path to record on the template.
 *
 * Content-addressed only in the loose sense that the caller has already sniffed
 * the type; the path itself is random, so uploading the same artwork twice
 * stores it twice. That is the right trade for a handful of templates: dedupe
 * would mean one template's background disappearing when another is replaced.
 */
export async function putAsset(input: {
  concertId: number;
  contentType: AssetContentType;
  bytes: Uint8Array;
}): Promise<string> {
  const { concertId, contentType, bytes } = input;
  if (bytes.byteLength === 0) throw new Error('Refusing to store an empty asset.');
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`Asset is larger than the ${MAX_ASSET_BYTES} byte limit.`);
  }

  const path = assetPath(concertId, contentType);
  const root = localRoot();

  if (root) {
    const file = localFile(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return path;
  }

  const { error } = await createSupabaseAdminClient()
    .storage.from(ASSET_BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Could not store the artwork: ${error.message}`);
  return path;
}

/**
 * Read stored bytes back, or null when the path holds nothing.
 *
 * **Null rather than a throw**, because both callers are better off degrading:
 * the editor shows the layout over a blank canvas, and the renderer prints a
 * ticket with no artwork behind it. A missing background is a design problem;
 * a guest at the door with no ticket is not.
 */
export async function getAsset(path: string): Promise<StoredAsset | null> {
  const contentType = contentTypeOf(path);
  if (!contentType) return null;

  const root = localRoot();
  if (root) {
    /**
     * Resolved **outside** the catch, so the two failures stay distinct. A
     * missing file is ordinary and returns null; a path trying to climb out of
     * the asset directory is not, and swallowing it into the same null would
     * hide the one case worth knowing about.
     */
    const file = localFile(root, path);
    try {
      return { path, contentType, bytes: new Uint8Array(await readFile(file)) };
    } catch {
      return null;
    }
  }

  const { data, error } = await createSupabaseAdminClient()
    .storage.from(ASSET_BUCKET)
    .download(path);
  if (error || !data) return null;
  return {
    path,
    contentType,
    bytes: new Uint8Array(await data.arrayBuffer()),
  };
}

/**
 * Delete stored bytes, best effort.
 *
 * Only ever called for an asset nothing references any more — a background
 * replaced before the template was saved. **A template version that has issued
 * tickets keeps its artwork**, because §10.5 pins the version and rendering the
 * pinned one has to keep working.
 */
export async function deleteAsset(path: string): Promise<void> {
  const root = localRoot();
  if (root) {
    await unlink(localFile(root, path)).catch(() => undefined);
    return;
  }
  await createSupabaseAdminClient().storage.from(ASSET_BUCKET).remove([path]);
}

/**
 * A weak validator for `<img>`-style cache headers on the serve route.
 *
 * The bytes at a path never change — the path is random and written once — so
 * the browser may keep the background for as long as it likes. The tag is over
 * the content rather than the path so a re-upload of identical artwork still
 * hits the cache.
 */
export function assetEtag(bytes: Uint8Array): string {
  return `"${createHash('sha1').update(bytes).digest('base64url')}"`;
}
