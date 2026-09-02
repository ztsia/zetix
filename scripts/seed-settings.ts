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
 */
import { getSql } from '../src/db/client';

/** Straight from the "System values — seeded, rarely changed" table in §6. */
const SYSTEM_SEEDS: Record<string, unknown> = {
  'portal.note_max_length': 1000,
  'form.rate_limit_per_ip_per_min': 5,
  'form.seat_indicator_exact_below': 20,
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
   */
  'allocation.extras_policy': { PLAYER_INVITED: 'REVIEW', PUBLIC: 'AUTO_FCFS' },
};

async function main() {
  const force = process.argv.includes('--force');
  const sql = getSql();
  let written = 0;

  for (const [key, value] of Object.entries(SYSTEM_SEEDS)) {
    const result = force
      ? await sql`
          insert into system_settings (key, value)
          values (${key}, ${JSON.stringify(value)}::jsonb)
          on conflict (key) do update set value = excluded.value
          returning key
        `
      : await sql`
          insert into system_settings (key, value)
          values (${key}, ${JSON.stringify(value)}::jsonb)
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
