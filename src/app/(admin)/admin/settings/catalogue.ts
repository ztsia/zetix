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
   * Bounds for a `number`, checked at save time.
   *
   * Not an operational *value* — it is what makes the value meaningful at all.
   * "−1 messages per dispatch" and "3.7 messages a day" are not tight
   * configurations, they are nonsense the cascade would then hand to the
   * dispatcher; a base quota of −3 is worse, because the entitlement guard
   * multiplies it. `integer` defaults to true: every number in §6 is a count, a
   * duration or a limit, except the one fraction below.
   */
  min?: number;
  max?: number;
  integer?: boolean;
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
        min: 0,
        label: 'Hall capacity',
        kind: 'number',
        description:
          'How many bodies fit in the room. Segments must fit inside it. Normally set per show rather than here.',
        operational: true,
        level: 'show',
      },
      {
        key: 'segment.capacity',
        min: 0,
        label: 'Segment capacity',
        kind: 'number',
        description:
          "A segment's slice of the hall. Seats in no segment are held seats — that is the only way to withhold any.",
        operational: true,
        level: 'segment',
      },
      {
        key: 'allocation.base_quota',
        min: 0,
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
        min: 0,
        label: 'Max tickets per response',
        kind: 'number',
        description: 'Party size cap.',
        operational: true,
        level: 'segment',
      },
      {
        key: 'form.extra_rows_max',
        min: 0,
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
        min: 1,
        label: 'Messages per dispatch',
        kind: 'number',
        description: 'Sized to stay inside the function timeout.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_per_day',
        min: 1,
        label: 'Messages per day',
        kind: 'number',
        description:
          'Gmail free-account quota guard, counted in the concert’s timezone rather than UTC days.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.inter_message_delay_ms',
        min: 0,
        label: 'Delay between messages (ms)',
        kind: 'number',
        description: 'Paces the dispatcher so a batch does not look like a burst.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_attempts',
        min: 1,
        label: 'Send attempts',
        kind: 'number',
        description: 'How many times a failed message is retried before it stays failed.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.merge_attachments_above',
        min: 0,
        label: 'Merge attachments above',
        kind: 'number',
        description: 'Past this many tickets, merge the PDFs into one attachment.',
        operational: false,
        level: 'system',
      },
      {
        key: 'email.max_attachment_mb',
        min: 1,
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
        min: 1,
        label: 'Offline manifest lifetime (hours)',
        kind: 'number',
        description: 'How long a downloaded manifest stays usable after the show starts.',
        operational: false,
        level: 'system',
      },
      {
        key: 'checkin.scan_debounce_ms',
        min: 0,
        label: 'Scan debounce (ms)',
        kind: 'number',
        description: 'Stops one ticket registering twice as the camera holds focus.',
        operational: false,
        level: 'system',
      },
      {
        key: 'import.fuzzy_match_threshold',
        min: 0,
        max: 1,
        integer: false,
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
        min: 1,
        label: 'Admin sign-in attempts',
        kind: 'number',
        description: 'Attempts per IP before a lockout begins.',
        operational: false,
        level: 'system',
      },
      {
        key: 'auth.admin_lockout_window_min',
        min: 1,
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
        min: 1,
        label: 'Note length limit',
        kind: 'number',
        description: 'Longest note an attendee may leave.',
        operational: false,
        level: 'system',
      },
      {
        key: 'form.rate_limit_per_ip_per_min',
        min: 1,
        label: 'Form submissions per IP per minute',
        kind: 'number',
        description: 'V2. Native registration forms only.',
        operational: false,
        level: 'system',
      },
      {
        key: 'form.seat_indicator_exact_below',
        min: 0,
        label: 'Show exact seats below',
        kind: 'number',
        description: 'Under this many seats left, the form shows a number instead of a band.',
        operational: false,
        level: 'system',
      },
      {
        key: 'form.verification_grace_hours',
        min: 1,
        label: 'Verification grace period (hours)',
        kind: 'number',
        description:
          'V2. An unverified public registration older than this is flagged for admin review. It keeps its seats either way — verification gates the email, never the seat.',
        operational: false,
        level: 'system',
      },
    ],
  },
  {
    title: 'Concert and portal defaults',
    blurb:
      'Every one of these is normally set on the concert, show or portal screen that owns it — a timezone belongs to a concert, an unlock mode to a show. They are listed here because §6 puts them in the cascade, and without a root there is no way to give them a fallback at all. Setting one here applies it to every concert that does not say otherwise.',
    settings: [
      {
        key: 'concert.timezone',
        label: 'Timezone',
        kind: 'text',
        description:
          'IANA zone. Show times are stored UTC and rendered in it, never the viewer’s. Normally set when the concert is created, which requires one.',
        operational: true,
        level: 'concert',
      },
      {
        key: 'portal.unlock_mode',
        label: 'Portal unlock',
        kind: 'text',
        description: 'ON_ADMISSION, OPEN_TO_ALL or CLOSED. Normally set per show.',
        operational: true,
        level: 'show',
      },
      {
        key: 'ticket.default_template_id',
        min: 1,
        label: 'Default ticket template',
        kind: 'number',
        description:
          'Resolves show → concert → the seeded global default. Normally chosen on the tickets screen; never read as a raw column.',
        operational: false,
        level: 'concert',
      },
      {
        key: 'show.auto_complete_after_hours',
        min: 0,
        label: 'Show counts as over after (hours)',
        kind: 'number',
        description:
          'V2. How long after a show’s end time the portal shows its post-show phase and the show auto-completes. Inert while the show has no end time — nothing is inferred from the start time.',
        /**
         * Seeded, not left empty, on `modules-v2.md` §3's explicit instruction:
         * "seeded at system level like every other runtime value and editable
         * per show and per concert". §6 lists it in its operational table, whose
         * preamble says the system ships with no numeric default — the same
         * tension `allocation.extras_policy` already sits in, and resolved the
         * same way. It describes the runtime (how long after the printed end
         * time we call an evening over), not the event, and with no value at any
         * level V2's post-show phase never happens at all.
         */
        operational: false,
        level: 'show',
      },
      {
        key: 'portal.booklet_enabled',
        label: 'Booklet section enabled',
        kind: 'boolean',
        description: 'V2. The booklet still only appears once a booklet is published.',
        operational: true,
        level: 'show',
      },
      {
        key: 'portal.feedback_enabled',
        label: 'Feedback section enabled',
        kind: 'boolean',
        description: 'V2. Whether the post-show feedback form appears in the portal at all.',
        operational: true,
        level: 'show',
      },
      {
        key: 'portal.feedback_close_at',
        label: 'Feedback closes at',
        kind: 'text',
        description: 'V2. An ISO timestamp, after which the feedback form stops accepting answers.',
        operational: true,
        level: 'show',
      },
      {
        key: 'portal.feedback_send_hour',
        min: 0,
        max: 23,
        label: 'Feedback send hour',
        kind: 'number',
        description:
          'V2. The hour, in the concert’s timezone, at which queued feedback email becomes due. The gap between queueing at ~10:30pm and sending is the review window, and it is what stops anyone being emailed at 10:30pm.',
        /** Seeded for the same reason as `show.auto_complete_after_hours` above. */
        operational: false,
        level: 'concert',
      },
      {
        key: 'portal.notes_enabled',
        label: 'Notes enabled',
        kind: 'boolean',
        description: 'V2. Whether attendees may leave notes at all.',
        operational: true,
        level: 'concert',
      },
      {
        key: 'portal.notes_close_at',
        label: 'Notes close at',
        kind: 'text',
        description: 'V2. An ISO timestamp, after which no new note is accepted.',
        operational: true,
        level: 'concert',
      },
      {
        key: 'portal.public_wall_enabled',
        label: 'Public wall enabled',
        kind: 'boolean',
        description:
          'V2. Publishing to the wall is always an explicit admin action regardless (decision 6).',
        operational: true,
        level: 'concert',
      },
      {
        key: 'portal.public_wall_visibility',
        label: 'Public wall visibility',
        kind: 'text',
        description:
          'V2. ADMIN_ONLY or AUDIENCE. Per-player grouping is admin-only always, whatever this says.',
        operational: true,
        level: 'concert',
      },
    ],
  },
];

export const ALL_SETTINGS: SettingSpec[] = SETTING_GROUPS.flatMap((group) => group.settings);

export function settingSpec(key: string): SettingSpec | undefined {
  return ALL_SETTINGS.find((spec) => spec.key === key);
}
