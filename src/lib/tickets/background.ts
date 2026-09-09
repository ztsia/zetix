import 'server-only';

import { getAsset } from './assets';
import type { AssetLoader, Background } from './render';

/**
 * The bridge between the asset store and the renderer.
 *
 * `renderTicket()` takes bytes and knows nothing about where artwork lives;
 * `assets.ts` stores bytes and knows nothing about tickets. This is the one
 * place that joins them, so every render path — the ticket PDF route, the
 * editor's draft preview, and module `F`'s blast — resolves a background the
 * same way.
 */

/**
 * The background for a pinned template, or `NONE`.
 *
 * **Never throws.** A template whose artwork has gone missing renders as type on
 * a blank page: the QR, the name and the code are all still there, so the ticket
 * still admits its holder. Failing the render instead would turn a lost file
 * into a guest at the door with nothing.
 */
export async function backgroundFor(template: {
  backgroundAssetPath: string | null;
  backgroundKind: 'IMAGE' | 'PDF' | 'NONE';
}): Promise<Background> {
  if (!template.backgroundAssetPath || template.backgroundKind === 'NONE') {
    return { kind: 'NONE' };
  }

  const asset = await getAsset(template.backgroundAssetPath).catch(() => null);
  if (!asset) return { kind: 'NONE' };

  if (asset.contentType === 'application/pdf') return { kind: 'PDF', bytes: asset.bytes };
  return { kind: 'IMAGE', bytes: asset.bytes, mime: asset.contentType };
}

/** The `IMAGE`-element loader, reading from the same store. */
export const loadTicketAsset: AssetLoader = (src) => getAsset(src).catch(() => null);
