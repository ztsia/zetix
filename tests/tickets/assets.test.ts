import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The asset store (spec/tickets.md §10.3).
 *
 * Exercised through the **local backend**, which is the one a cloud container
 * and CI can reach: there is no network route to a Supabase bucket's contents
 * and no service-role key here (`docs/local.md` §7). The two backends share
 * every rule tested below except where the bytes land, so this covers the
 * sniffing, the limits and the traversal guard for both.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zetix-assets-'));
  process.env.TICKET_ASSET_DIR = dir;
});

afterAll(() => {
  delete process.env.TICKET_ASSET_DIR;
});

const {
  MAX_ASSET_BYTES,
  assetKind,
  contentTypeOf,
  deleteAsset,
  getAsset,
  isAssetContentType,
  putAsset,
  sniffContentType,
} = await import('@/lib/tickets/assets');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

describe('sniffContentType', () => {
  it('reads the file, not its name', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(PDF)).toBe('application/pdf');
  });

  it('refuses anything else', () => {
    // The failure this prevents: a renamed text file typed `image/png` by the
    // browser, accepted here, and thrown by pdf-lib deep inside the render of
    // every ticket in the show.
    expect(sniffContentType(new TextEncoder().encode('not artwork'))).toBeNull();
    expect(sniffContentType(new Uint8Array())).toBeNull();
  });
});

describe('kinds and extensions', () => {
  it('maps a content type to the column value and back', () => {
    expect(assetKind('image/png')).toBe('IMAGE');
    expect(assetKind('image/jpeg')).toBe('IMAGE');
    expect(assetKind('application/pdf')).toBe('PDF');

    expect(contentTypeOf('concerts/1/x.png')).toBe('image/png');
    expect(contentTypeOf('concerts/1/x.jpg')).toBe('image/jpeg');
    expect(contentTypeOf('concerts/1/x.pdf')).toBe('application/pdf');
    expect(contentTypeOf('concerts/1/x.gif')).toBeNull();
  });

  it('knows what it accepts', () => {
    expect(isAssetContentType('image/png')).toBe(true);
    expect(isAssetContentType('image/gif')).toBe(false);
  });
});

describe('putAsset and getAsset', () => {
  it('round-trips bytes through a path', async () => {
    const path = await putAsset({ concertId: 7, contentType: 'image/png', bytes: PNG });
    expect(path).toMatch(/^concerts\/7\/[0-9a-f-]+\.png$/);

    const asset = await getAsset(path);
    expect(asset?.contentType).toBe('image/png');
    expect(Array.from(asset?.bytes ?? [])).toEqual(Array.from(PNG));
  });

  it('never collides, so re-uploading does not replace another template’s artwork', async () => {
    const first = await putAsset({ concertId: 7, contentType: 'image/png', bytes: PNG });
    const second = await putAsset({ concertId: 7, contentType: 'image/png', bytes: PNG });
    expect(first).not.toBe(second);

    expect(await getAsset(first)).not.toBeNull();
    expect(await getAsset(second)).not.toBeNull();
  });

  it('refuses an empty file and one over the limit', async () => {
    await expect(
      putAsset({ concertId: 1, contentType: 'image/png', bytes: new Uint8Array() }),
    ).rejects.toThrow(/empty/i);

    await expect(
      putAsset({
        concertId: 1,
        contentType: 'image/png',
        bytes: new Uint8Array(MAX_ASSET_BYTES + 1),
      }),
    ).rejects.toThrow(/limit/i);
  });

  it('returns null for a path that holds nothing', async () => {
    // Null rather than a throw: a template whose artwork went missing still has
    // to render, or a lost file becomes a guest at the door with no ticket.
    expect(await getAsset('concerts/1/missing.png')).toBeNull();
    expect(await getAsset('concerts/1/notanasset.gif')).toBeNull();
  });

  it('refuses to read its way out of the asset directory', async () => {
    // `background_asset_path` is a text column. A `../` in it would otherwise
    // read any file the server process can reach.
    await writeFile(join(dir, 'secret.png'), 'not for you');
    await expect(getAsset('../secret.png')).rejects.toThrow(/escapes/i);
    await expect(getAsset('concerts/../../secret.png')).rejects.toThrow(/escapes/i);
  });

  it('deletes, and shrugs at a path that is already gone', async () => {
    const path = await putAsset({ concertId: 9, contentType: 'application/pdf', bytes: PDF });
    await deleteAsset(path);
    expect(await getAsset(path)).toBeNull();
    await expect(deleteAsset(path)).resolves.toBeUndefined();
  });

  it('keeps each concert’s artwork in its own folder', async () => {
    await putAsset({ concertId: 11, contentType: 'image/jpeg', bytes: JPEG });
    expect(await readdir(join(dir, 'concerts', '11'))).toHaveLength(1);
  });
});
