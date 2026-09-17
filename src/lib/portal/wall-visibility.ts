/**
 * `portal.public_wall_visibility`, resolved through the cascade — never read
 * off `concerts.public_wall_visibility` (§2.2).
 *
 * **Its own module, and deliberately not `server-only`.** The wall section and
 * the admin screen both need the type, and one of them is a client component:
 * folding this into `status.ts` would drag that file's `server-only` import
 * into the browser bundle and fail the build. `M` split
 * `email/address-typo.ts` from `email/address.ts` for the same reason, and
 * recorded it in its handoff after paying for it.
 */

/**
 * Who may read the public wall.
 *
 * - `ADMIN_ONLY` — the wall exists and is being curated, but no guest sees it.
 * - `AUDIENCE` — a ticket holder who has unlocked the portal sees published
 *   notes.
 *
 * **Per-player grouping is admin-only whatever this says** (decision 6). This
 * governs the anonymous, published wall and nothing else; the grouped view is
 * how the orchestra prepares what goes back to players and is never a guest
 * surface.
 */
export type PublicWallVisibility = 'ADMIN_ONLY' | 'AUDIENCE';

export function isWallVisibility(value: unknown): value is PublicWallVisibility {
  return value === 'ADMIN_ONLY' || value === 'AUDIENCE';
}

/**
 * Whether a *guest* may read the wall, from the two settings that decide it.
 *
 * **Both must say yes, and an unresolved value is no.** The failure direction
 * that matters here is the one that publishes an attendee's words to strangers
 * before anyone meant to: `portal.public_wall_enabled` carries no seed, so null
 * means nobody has configured this concert's wall, exactly as a null capacity
 * means nobody has configured the hall (spec/README.md §2.1). A wall shown
 * early cannot be un-shown once a guest has read it; a wall held back is one
 * settings change away.
 *
 * This is **not** the admin's view. An admin reads every note at every setting,
 * through the console, which is the only place the grouped view exists.
 */
export function wallIsPublic(input: {
  enabled: boolean;
  visibility: PublicWallVisibility | null;
}): boolean {
  return input.enabled && input.visibility === 'AUDIENCE';
}
