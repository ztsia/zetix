/**
 * Install seed for `system_settings` — the root of the cascade.
 *
 * **Only the "System values" half of spec/domain.md §6 belongs here.** Those
 * describe the runtime rather than the event — send batch sizes, scan debounce,
 * lockout windows — and the spec gives each a seed, so writing them at install
 * is correct.
 *
 * **The "Operational values" half is deliberately absent**: capacities, quotas,
 * deadlines and party caps ship with no value at any level. A missing one is a
 * validation error at save time, not a silent fallback (spec/README.md §2.1,
 * decision 18). If you find yourself adding `capacity` here, that is the bug
 * the rule exists to prevent.
 *
 * Idempotent — re-running it does not overwrite a value an admin has since
 * changed. Use `--force` to reset every key back to its seed.
 *
 *   pnpm tsx scripts/seed-settings.ts [--force]
 *
 * **The `::text::jsonb` cast below is load-bearing.** With a bare `::jsonb`,
 * `postgres.js` infers the parameter type from the cast and JSON-encodes the
 * string we already serialised, so every value lands one level too deep — a
 * jsonb *string* rather than a number, boolean or object. Nothing errors:
 * `keepalive.enabled` becomes the string "true" (still truthy),
 * `email.max_per_dispatch` becomes "25", and `allocation.extras_policy` becomes
 * a string that never matches the per-audience branch in `resolve_setting`, so a
 * player segment silently auto-grants extras that decision 4 says must be held
 * for review. Casting through `text` first sends it as text and lets Postgres
 * parse it, which is what we meant.
 */
import './load-env';
import { getSql } from '../src/db/client';

/** Straight from the "System values — seeded, rarely changed" table in §6. */
const SYSTEM_SEEDS: Record<string, unknown> = {
  'portal.note_max_length': 1000,
  'form.rate_limit_per_ip_per_min': 5,
  'form.seat_indicator_exact_below': 20,
  'form.verification_grace_hours': 48,
  'auth.admin_max_attempts': 5,
  'auth.admin_lockout_window_min': 15,
  'email.transport': 'gmail_smtp',
  'email.max_per_dispatch': 25,
  'email.max_per_day': 450,
  'email.inter_message_delay_ms': 400,
  'email.max_attempts': 3,
  'email.merge_attachments_above': 8,
  'email.max_attachment_mb': 20,
  'checkin.manifest_ttl_hours': 12,
  'checkin.scan_debounce_ms': 1500,
  'import.fuzzy_match_threshold': 0.85,
  'keepalive.enabled': true,

  /**
   * Decision 4: player segments default to REVIEW, public segments to
   * AUTO_FCFS. Stored as an object keyed by audience mode so the default stays
   * data — a literal in a `.tsx` file would be the same bug as a hardcoded
   * capacity. `resolve_setting` picks the branch from the segment.
   *
   * §6 lists this key in its *operational* table, whose preamble says the
   * system "ships with no **numeric** default for any of them". This one is not
   * numeric, and decision 4 states its defaults outright — so seeding it is how
   * that decision is expressed as data rather than as a constant in a form.
   * The alternative reading, that it must never be seeded, would leave
   * decision 4's defaults living nowhere at all.
   *
   * Note what this does *not* soften: `claim_seats()` still raises when the key
   * resolves to nothing, so a database seeded by hand and missing it fails loudly
   * rather than auto-granting what should have been reviewed.
   */
  'allocation.extras_policy': { PLAYER_INVITED: 'REVIEW', PUBLIC: 'AUTO_FCFS' },

  /**
   * The two V2 keys `docs/modules-v2.md` §3 says to seed at system level "like
   * every other runtime value", editable per show and per concert.
   *
   * §6 lists both in its *operational* table, whose preamble says the system
   * ships with no numeric default — so this is the same tension
   * `allocation.extras_policy` above already sits in, and it is resolved the
   * same way. Both describe the runtime rather than the event: how long after
   * the printed end time an evening counts as over, and what hour of the day is
   * a civil one to email people at. Neither is a capacity, a quota or a
   * deadline, and neither comes from `context.md`.
   *
   * **The numbers are the spec's own worked examples, not a choice made here.**
   * `spec/v2.md` §13.2.1 calls the flip "the two-hour precision" and §13.5.2
   * walks through "a show marked complete at 10:30pm with a send hour of noon".
   * They are a starting point an admin overrides at show or concert level, which
   * is the whole reason they are data rather than constants.
   *
   * What this does *not* soften: with `shows.ends_at` null both stay inert —
   * there is no post-show phase and no auto-completion at all (decision 41), and
   * no duration is inferred from `starts_at`.
   */
  'show.auto_complete_after_hours': 2,
  'portal.feedback_send_hour': 12,

  /**
   * V3 (spec/v3.md §30.2), seeded here for the same reason as the two above:
   * each describes the runtime or a review policy, not this event, and the
   * spec's table gives each its seed. A per-concert receipt hold or a
   * per-segment auto-approve overrides these through the cascade.
   *
   * `scheduler.tick_minutes` and `scheduler.history_days` are read by
   * `schedule_scheduler_jobs()` in the database (`drizzle/0200`), which refuses
   * to schedule anything while they are unset.
   */
  'email.receipt_hold_minutes': 10,
  'review.auto_approve_clean': false,
  'review.duplicate_name_similarity': 0.8,
  'delivery.review_single_party': false,
  'admin.typed_confirm_above': 20,
  'scheduler.tick_minutes': 10,
  'scheduler.history_days': 7,
  'inbox.match_fallback_days': 30,
  'inbox.sync_budget_seconds': 20,

  /**
   * Module `Y` (spec/v3.md §32.5): walk-ins are off until a concert turns them
   * on, and one tap records at most this many people. Both describe the door's
   * runtime, not this event.
   */
  'checkin.walk_ins_enabled': false,
  'checkin.walk_in_max_headcount': 10,
};

async function main() {
  const force = process.argv.includes('--force');
  const sql = getSql();
  let written = 0;

  for (const [key, value] of Object.entries(SYSTEM_SEEDS)) {
    const result = force
      ? await sql`
          insert into system_settings (key, value)
          values (${key}, ${JSON.stringify(value)}::text::jsonb)
          on conflict (key) do update set value = excluded.value
          returning key
        `
      : await sql`
          insert into system_settings (key, value)
          values (${key}, ${JSON.stringify(value)}::text::jsonb)
          on conflict (key) do nothing
          returning key
        `;
    written += result.length;
  }

  console.log(
    `system_settings: ${written} of ${Object.keys(SYSTEM_SEEDS).length} keys written` +
      (force ? ' (forced)' : ' (existing values left alone)'),
  );
  console.log(
    'No capacity, quota or deadline was seeded — those are entered per concert (§6).',
  );
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
