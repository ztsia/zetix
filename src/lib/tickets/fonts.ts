import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The faces the renderer can embed, and the only ones a layout may name.
 *
 * `spec/tickets.md` §10.4 requires fonts to be self-hosted and embedded, because
 * a serverless runtime has almost no system fonts and the render must match what
 * the editor showed. That makes an unknown `font_family` an **error rather than
 * a fallback**: substituting a face silently changes every text metric, so
 * shrink-to-fit stops agreeing with the canvas and a name that fitted in the
 * preview overflows on paper — discovered by the guest holding the ticket.
 *
 * Keyed by the `font_family` string a layout uses (§10.2) plus the weight.
 * See `src/assets/fonts/README.md` for provenance and how to add a face.
 */
const FACES = {
  'Inter:400': 'Inter-Regular.ttf',
  'Inter:600': 'Inter-SemiBold.ttf',
  'JetBrains Mono:400': 'JetBrainsMono-Regular.ttf',
} as const;

export type FaceKey = keyof typeof FACES;

/** The weights each family ships, for callers that need to resolve a request. */
const WEIGHTS_BY_FAMILY = new Map<string, number[]>([
  ['Inter', [400, 600]],
  ['JetBrains Mono', [400]],
]);

/**
 * Where the traced font files live at runtime.
 *
 * `next.config.ts` lists `./src/assets/fonts/**` under `outputFileTracingIncludes`
 * for `/api/**`: files read from disk are not traced automatically, and an
 * untraced font fails **only in production, only in the render path** — that is,
 * on the day tickets go out. Anything that renders a ticket must therefore be
 * reachable under `/api`, or extend that trace.
 */
const FONT_DIR = join(process.cwd(), 'src', 'assets', 'fonts');

const cache = new Map<FaceKey, Uint8Array>();

/**
 * Resolve a layout's `font_family` / `font_weight` to a face key.
 *
 * Weight snaps to the nearest available weight in the family, which is a
 * genuine fallback rather than a silent substitution: the glyphs are still the
 * family the template asked for, and §10.2 lets an editor emit any numeric
 * weight while only two are vendored. An unknown *family* is not recoverable
 * that way and throws.
 */
export function resolveFace(family: string, weight = 400): FaceKey {
  const weights = WEIGHTS_BY_FAMILY.get(family);
  if (!weights) {
    throw new Error(
      `No embedded font for family "${family}". Fonts are vendored, never ` +
        `substituted (spec/tickets.md §10.4) — add the file to src/assets/fonts ` +
        `and register it. Available: ${[...WEIGHTS_BY_FAMILY.keys()].join(', ')}.`,
    );
  }
  const nearest = weights.reduce((best, w) =>
    Math.abs(w - weight) < Math.abs(best - weight) ? w : best,
  );
  return `${family}:${nearest}` as FaceKey;
}

/** The TTF bytes for a face. Read once per process, then cached. */
export function loadFace(key: FaceKey): Uint8Array {
  const cached = cache.get(key);
  if (cached) return cached;

  const file = FACES[key];
  if (!file) throw new Error(`Unknown face "${key}".`);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(FONT_DIR, file));
  } catch (cause) {
    throw new Error(
      `Could not read the embedded font ${file} from ${FONT_DIR}. On Vercel ` +
        `this means the file was not traced into the function bundle — check ` +
        `outputFileTracingIncludes in next.config.ts covers the route that is ` +
        `rendering.`,
      { cause },
    );
  }
  cache.set(key, bytes);
  return bytes;
}

/** Every face, for tests and for warming the cache. */
export function allFaceKeys(): FaceKey[] {
  return Object.keys(FACES) as FaceKey[];
}
