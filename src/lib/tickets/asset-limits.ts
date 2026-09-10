/**
 * What a ticket asset may weigh, and how to say so — on both sides of the wire
 * (spec/tickets.md §10.3).
 *
 * Split out of `assets.ts` because that module is `server-only`: it opens
 * `node:fs` and the Supabase admin client, so a client component importing the
 * limit from there would fail the build. The number and the sentence therefore
 * live here, where the editor and the route can both reach them, and neither
 * side gets to have its own idea of either.
 */

/**
 * The upload ceiling, **4 MB**.
 *
 * A platform limit rather than an operational value (`CLAUDE.md`): Vercel
 * rejects a request body over about 4.5 MB before any of this code runs — it
 * answers `FUNCTION_PAYLOAD_TOO_LARGE` as `text/plain`, which is not the JSON
 * the editor is parsing, so the admin gets a bare "The upload failed" with no
 * number in it. Staying under that ceiling is what keeps the error ours, and
 * therefore useful. Nothing an admin can tune, so it is not a cascade setting.
 */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** `4 MB`, `8.1 MB` — one decimal only when it earns one. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * The one sentence an oversized upload gets, wherever it is caught.
 *
 * Leads with the file's own size, because "too large" without a number leaves
 * the admin guessing how much to shrink it by — which is the state this
 * function exists to end.
 */
export function tooLargeMessage(size: number): string {
  return `That file is ${formatBytes(size)}. The limit is ${formatBytes(MAX_ASSET_BYTES)}.`;
}
