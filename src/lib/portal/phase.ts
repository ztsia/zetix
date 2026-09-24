import { sql } from 'drizzle-orm';

/**
 * "The show is over", as one SQL expression (spec/v2.md §13.2.1, decision 40).
 *
 * ```
 * show is over  ⇔  now() > shows.ends_at + resolveSetting('show.auto_complete_after_hours')
 * ```
 *
 * **It is a phase, derived on read, not a flag anyone writes.** No job sets it
 * and nothing stores it, so the portal is correct the instant it is true — a
 * guest opening their link at 11pm on concert night gets the feedback form
 * rather than a page waiting for a cron. Only `shows.status = 'COMPLETED'` and
 * the feedback email wait for the daily sweep, and neither is visible to anyone
 * (§13.5.3).
 *
 * **One expression, two callers, deliberately.** The portal asks "what phase is
 * this attendee's show in?" and auto-completion asks "which shows are over?" —
 * the same question at two cardinalities. Two implementations of one predicate
 * drift apart, and the way they would drift here is a show whose portal has
 * moved on while the flag and the email have not, or the reverse. `db/settings.ts`
 * makes exactly this argument about the cascade itself and resolves it the same
 * way: the definition lives in SQL, and TypeScript is the typed doorway to it.
 *
 * **Null `ends_at` is not "over", ever** (decision 41). No duration is inferred
 * from `starts_at`: a concert with an interval runs well past its nominal
 * length, and a portal that flipped to *"how was your evening?"* mid-performance
 * would be worse than one that waited for a human.
 *
 * **An unresolved `show.auto_complete_after_hours` is not "over" either.** It
 * resolves through the full cascade — show `defaults` → concert `defaults` →
 * `system_settings`, where `scripts/seed-settings.ts` seeds it — and with no
 * value at any level there is simply no post-show phase, which is what the
 * settings catalogue says this key does when unset. Treating "unset" as zero
 * would be a code default for an operational value (spec/README.md §2.1), and
 * the one it would invent is the most aggressive value available.
 *
 * The `jsonb_typeof` guard is what makes that true for a *malformed* value as
 * well as a missing one. The subquery yields no row, the interval is null, the
 * comparison is null, and the phase is simply not reached — so a hand-edited
 * setting fails towards "not over", the direction that shows a guest a ticket
 * they still need rather than a feedback form for a concert they have not seen.
 *
 * **The alias is `s`**, matching `HAS_UNISSUED_SEAT`'s convention in
 * `lib/email/queue.ts`: the fragment names the columns it needs and the caller
 * supplies a query where `s` is `shows`.
 */
export const SHOW_IS_OVER = sql`
  (
    s.ends_at is not null
    and now() > s.ends_at + (
      select (t.v #>> '{}')::numeric * interval '1 hour'
        from (
          select resolve_setting('show.auto_complete_after_hours', null, s.id, s.concert_id) as v
        ) t
       where jsonb_typeof(t.v) = 'number'
    )
  )
`;
