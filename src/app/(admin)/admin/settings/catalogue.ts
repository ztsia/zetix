/**
 * The tunables, as described by spec/domain.md §6.
 *
 * **This is metadata, not configuration.** It says which keys exist, what type
 * each holds and what it means — never what any of them is set to. A number from
 * `context.md` appearing in this file would be exactly the bug `CLAUDE.md`
 * forbids; the values live in `system_settings`, seeded for the system half by
 * `scripts/seed-settings.ts` and typed in by an admin for the operational half.
 *
 * It exists so the settings screen can render a jsonb key/value table as a form
 * that knows a boolean from a count, and so a key nobody has set yet is still
 * *listed* — an operational value that is missing does not fail now, it fails
 * later at allocation or at a blast, and a screen that only shows rows that
 * exist would never mention it.
 */

export type SettingKind = 'number' | 'boolean' | 'text' | 'json';

export type SettingSpec = {
  key: string;
  label: string;
  kind: SettingKind;
  description: string;
  /**
   * Operational values describe the event and carry **no seed at any level**; a
   * missing one is a validation error at save time (§6, decision 18). System
   * values describe the runtime and are seeded at install.
   */
  operational: boolean;
  /** The level §6 says owns this key, for the "usually set on…" hint. */
  level: 'segment' | 'show' | 'concert' | 'system';
};

export const SETTING_GROUPS: { title: string; blurb: string; settings: SettingSpec[] }[] = [
  {
    title: 'Allocation',
    blurb:
      'These describe this event, so they ship with no value anywhere. A segment, show or concert overrides the root; what you set here is the fallback when none of them does.',
    settings: [
      {
        key: 'capacity',
        label: 'Hall capacity',
        kind: 'number',
        description:
          'How many bodies fit in the room. Segments must fit inside it. Normally set per show rather than here.',
        operational: true,
        level: 'show',
      },
      {
        key: 'segment.capacity',
        label: 'Segment capacity',
        kind: 'number',
        description:
          "A segment's slice of the hall. Seats in no segment are held seats — that is the only way to withhold any.",
        operational: true,
        level: 'segment',
      },
      {
        key: 'allocation.base_quota',
        label: 'Base quota per player',
        kind: 'number',
        description:
          'Seats each active player is entitled to in a player-invited segment. Raising it here raises it for every segment that does not override it, and the entitlement guard checks all of them.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'allocation.base_claim_deadline',
        label: 'Base claim deadline',
        kind: 'text',
        description:
          'After this, unclaimed base seats release into the segment’s extras pool. An ISO timestamp.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'allocation.extras_policy',
        label: 'Extras policy',
        kind: 'json',
        description:
          'REVIEW or AUTO_FCFS. Stored as an object keyed by audience mode — {"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"} — so one root value serves both.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'allocation.allow_partial_grant',
        label: 'Allow partial grants',
        kind: 'boolean',
        description:
          'Whether a request at the boundary of the pool may be granted in part rather than skipped whole.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'form.max_tickets_per_response',
        label: 'Max tickets per response',
        kind: 'number',
        description: 'Party size cap.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'form.extra_rows_max',
        label: 'Extra request rows',
        kind: 'number',
        description: 'Rows in the "request extras" repeater.',
        operational: true,
        level: 'segment',
      },
    ],
  },
  {
    title: 'Email',
    blurb:
      'These describe the runtime rather than the event, so they are seeded at install and rarely changed. Most are sized around Gmail’s limits and the function timeout.',
    settings: [
      {
        key: 'email.transport',
        label: 'Transport',
        kind: 'text',
        description: 'The active transport. Alternatives are adapters, not rewrites.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_per_dispatch',
        label: 'Messages per dispatch',
        kind: 'number',
        description: 'Sized to stay inside the function timeout.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_per_day',
        label: 'Messages per day',
        kind: 'number',
        description:
          'Gmail free-account quota guard, counted in the concert’s timezone rather than UTC days.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.inter_message_delay_ms',
        label: 'Delay between messages (ms)',
        kind: 'number',
        description: 'Paces the dispatcher so a batch does not look like a burst.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_attempts',
        label: 'Send attempts',
        kind: 'number',
        description: 'How many times a failed message is retried before it stays failed.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.merge_attachments_above',
        label: 'Merge attachments above',
        kind: 'number',
        description: 'Past this many tickets, merge the PDFs into one attachment.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_attachment_mb',
        label: 'Max attachment size (MB)',
        kind: 'number',
        description: 'Gmail’s ceiling is 25MB; leave headroom.',
        operational: false,
        level: 'system',
      },
    ],
  },
  {
    title: 'Door and import',
    blurb: 'Runtime behaviour at the door and on the import screen.',
    settings: [
      {
        key: 'checkin.manifest_ttl_hours',
        label: 'Offline manifest lifetime (hours)',
        kind: 'number',
        description: 'How long a downloaded manifest stays usable after the show starts.',
        operational: false,
        level: 'system',
      },
      {
        key: 'checkin.scan_debounce_ms',
        label: 'Scan debounce (ms)',
        kind: 'number',
        description: 'Stops one ticket registering twice as the camera holds focus.',
        operational: false,
        level: 'system',
      },
      {
        key: 'import.fuzzy_match_threshold',
        label: 'Player match threshold',
        kind: 'number',
        description: 'Below this, a player match needs confirmation rather than being applied.',
        operational: false,
        level: 'system',
      },
    ],
  },
  {
    title: 'Sign-in and platform',
    blurb:
      'The admin code is the entire security boundary for every attendee’s name and email, so the lockout settings are not cosmetic.',
    settings: [
      {
        key: 'auth.admin_max_attempts',
        label: 'Admin sign-in attempts',
        kind: 'number',
        description: 'Attempts per IP before a lockout begins.',
        operational: false,
        level: 'system',
      },
      {
        key: 'auth.admin_lockout_window_min',
        label: 'Lockout window (minutes)',
        kind: 'number',
        description: 'How long those attempts are counted over.',
        operational: false,
        level: 'system',
      },
      {
        key: 'keepalive.enabled',
        label: 'Daily database ping',
        kind: 'boolean',
        description:
          'Defeats the Supabase idle pause. Turning this off will eventually pause the project.',
        operational: false,
        level: 'system',
      },
    ],
  },
  {
    title: 'Portal and notes',
    blurb: 'Mostly V2, kept here so the values exist before the screens that read them.',
    settings: [
      {
        key: 'portal.note_max_length',
        label: 'Note length limit',
        kind: 'number',
        description: 'Longest note an attendee may leave.',
        operational: false,
        level: 'system',
      },
      {
        key: 'form.rate_limit_per_ip_per_min',
        label: 'Form submissions per IP per minute',
        kind: 'number',
        description: 'V2. Native registration forms only.',
        operational: false,
        level: 'system',
      },
      {
        key: 'form.seat_indicator_exact_below',
        label: 'Show exact seats below',
        kind: 'number',
        description: 'Under this many seats left, the form shows a number instead of a band.',
        operational: false,
        level: 'system',
      },
    ],
  },
];

export const ALL_SETTINGS: SettingSpec[] = SETTING_GROUPS.flatMap((group) => group.settings);

export function settingSpec(key: string): SettingSpec | undefined {
  return ALL_SETTINGS.find((spec) => spec.key === key);
}
