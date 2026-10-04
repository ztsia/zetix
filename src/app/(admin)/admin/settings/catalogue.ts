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
  /**
   * A concert may override it: Setup › Concert lists it (spec/v3.md §29.1).
   *
   * **True only where every read of the key carries the concert** — a segment,
   * a show or the concert itself, which `resolve_setting()` walks up from. A
   * key read with no context at all (the dispatcher's rate limits, the
   * scheduler, sign-in lockout) would ignore a concert's value, and offering
   * it there would be a control that silently does nothing.
   */
  concert?: true;
  /** A `text` key that holds one of these, as its database enum spells them. */
  values?: readonly string[];
  /** A `text` key that holds an instant, stored as ISO 8601 in UTC. */
  format?: 'timestamp';
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
        concert: true,
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
        concert: true,
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
        concert: true,
      },
      {
        key: 'allocation.base_claim_deadline',
        label: 'Base claim deadline',
        kind: 'text',
        description:
          'After this, unclaimed base seats release into the segment’s extras pool. An ISO timestamp.',
        operational: true,
        level: 'segment',
        format: 'timestamp',
        concert: true,
      },
      {
        key: 'allocation.extras_policy',
        label: 'Extras policy',
        kind: 'json',
        description:
          'REVIEW or AUTO_FCFS. Stored as an object keyed by audience mode — {"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"} — so one root value serves both.',
        operational: true,
        level: 'segment',
        concert: true,
      },
      {
        key: 'allocation.allow_partial_grant',
        label: 'Allow partial grants',
        kind: 'boolean',
        description:
          'Whether a request at the boundary of the pool may be granted in part rather than skipped whole.',
        operational: true,
        level: 'segment',
        concert: true,
      },
      {
        key: 'form.max_tickets_per_response',
        min: 0,
        label: 'Max tickets per response',
        kind: 'number',
        description: 'Party size cap.',
        operational: true,
        level: 'segment',
        concert: true,
      },
      {
        key: 'form.extra_rows_max',
        min: 0,
        label: 'Extra request rows',
        kind: 'number',
        description: 'Rows in the "request extras" repeater.',
        operational: true,
        level: 'segment',
        concert: true,
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
        key: 'email.from_name',
        label: 'Sender name',
        kind: 'text',
        description:
          'The name every message is sent under, beside the mailbox address: the organisation’s, never seeded. Blank sends from the address alone.',
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
        concert: true,
      },
      {
        key: 'checkin.scan_debounce_ms',
        min: 0,
        label: 'Scan debounce (ms)',
        kind: 'number',
        description: 'Stops one ticket registering twice as the camera holds focus.',
        operational: false,
        level: 'system',
        concert: true,
      },
      {
        key: 'checkin.walk_ins_enabled',
        label: 'Record walk-ins at the door',
        kind: 'boolean',
        description:
          'Lets ushers record people admitted with no ticket — a headcount and, optionally, a name (spec/v3.md §32.2).',
        operational: false,
        level: 'system',
        concert: true,
      },
      {
        key: 'checkin.walk_in_max_headcount',
        min: 1,
        label: 'Largest walk-in group',
        kind: 'number',
        description: 'The most people one walk-in tap may record, so a typo of 30 for 3 is caught.',
        operational: false,
        level: 'system',
        concert: true,
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
        concert: true,
      },
    ],
  },
  {
    title: 'Sign-in and platform',
    blurb:
      'A console password is the entire security boundary for every attendee’s name and email, so the lockout settings are not cosmetic. They apply per IP and per account.',
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
        concert: true,
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
        label: 'Show exact seats above',
        kind: 'number',
        description:
          'Once fewer than this many seats remain, the form stops naming the figure and says ' +
          '“only a few seats left”. It exists to avoid a stampede, so scarcity is what goes vague.',
        operational: false,
        level: 'system',
        concert: true,
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
        key: 'portal.enabled',
        label: 'Portal enabled',
        kind: 'boolean',
        /**
         * V2. The master switch for §13.3's sections — booklet, notes, wall,
         * practical info, feedback.
         *
         * **It does not gate the ticket status page**, which is served to every
         * real token regardless: a printed QR cannot be recalled when a flag is
         * flipped, so turning the portal off must never turn a ticket into a
         * dead link (`spec/v2.md` §13.2).
         *
         * Listed here because `concerts.portal_enabled` is written by no form —
         * without this entry the value resolves to null at every level, every
         * section is off, and there is no way to turn the portal on at all.
         */
        description:
          'V2. Whether the portal’s sections appear at all. The ticket status page is always served, flag or no flag.',
        operational: true,
        level: 'concert',
        concert: true,
      },
      {
        key: 'portal.unlock_mode',
        label: 'Portal unlock',
        kind: 'text',
        description: 'ON_ADMISSION, OPEN_TO_ALL or CLOSED. Normally set per show.',
        operational: true,
        level: 'show',
        values: ['ON_ADMISSION', 'OPEN_TO_ALL', 'CLOSED'],
        concert: true,
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
        concert: true,
      },
      {
        key: 'portal.booklet_enabled',
        label: 'Booklet section enabled',
        kind: 'boolean',
        description: 'V2. The booklet still only appears once a booklet is published.',
        operational: true,
        level: 'show',
        concert: true,
      },
      {
        key: 'portal.feedback_enabled',
        label: 'Feedback section enabled',
        kind: 'boolean',
        description: 'V2. Whether the post-show feedback form appears in the portal at all.',
        operational: true,
        level: 'show',
        concert: true,
      },
      {
        key: 'portal.feedback_close_at',
        label: 'Feedback closes at',
        kind: 'text',
        description: 'V2. An ISO timestamp, after which the feedback form stops accepting answers.',
        operational: true,
        level: 'show',
        format: 'timestamp',
        concert: true,
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
        concert: true,
      },
      {
        key: 'portal.notes_enabled',
        label: 'Notes enabled',
        kind: 'boolean',
        description: 'V2. Whether attendees may leave notes at all.',
        operational: true,
        level: 'concert',
        concert: true,
      },
      {
        key: 'portal.notes_close_at',
        label: 'Notes close at',
        kind: 'text',
        description: 'V2. An ISO timestamp, after which no new note is accepted.',
        operational: true,
        level: 'concert',
        format: 'timestamp',
        concert: true,
      },
      {
        key: 'portal.public_wall_enabled',
        label: 'Public wall enabled',
        kind: 'boolean',
        description:
          'V2. Publishing to the wall is always an explicit admin action regardless (decision 6).',
        operational: true,
        level: 'concert',
        concert: true,
      },
      {
        key: 'portal.public_wall_visibility',
        label: 'Public wall visibility',
        kind: 'text',
        description:
          'V2. ADMIN_ONLY or AUDIENCE. Per-player grouping is admin-only always, whatever this says.',
        operational: true,
        level: 'concert',
        values: ['ADMIN_ONLY', 'AUDIENCE'],
        concert: true,
      },
    ],
  },
  {
    /**
     * The nine keys V3 adds (spec/v3.md §30.2). Every one is seeded at system
     * level like any other runtime value — none is a code default — and every
     * one describes the runtime or a review policy, not this event.
     */
    title: 'Review, delivery and scheduling',
    blurb:
      'V3. How intake is reviewed, how receipts and replies are handled, and how often the scheduler runs. Seeded at install; change them here or per concert or segment where noted.',
    settings: [
      {
        key: 'email.receipt_hold_minutes',
        min: 0,
        max: 1440,
        label: 'Receipt hold (minutes)',
        kind: 'number',
        description:
          'How long a receipt waits before it is due. Repeat submissions from the same address inside it collapse into one email. Usually set per concert.',
        operational: false,
        level: 'concert',
        concert: true,
      },
      {
        key: 'review.auto_approve_clean',
        label: 'Auto-approve clean parties',
        kind: 'boolean',
        description:
          'Approve a party with no flags the moment it submits, so only flagged parties wait in Needs review. Usually set per segment.',
        operational: false,
        level: 'segment',
        concert: true,
      },
      {
        key: 'review.duplicate_name_similarity',
        min: 0,
        max: 1,
        integer: false,
        label: 'Duplicate name similarity',
        kind: 'number',
        description:
          'Two parties in a show whose contact or guest names are at least this similar (0–1) are shown as possible duplicates.',
        operational: false,
        level: 'system',
        concert: true,
      },
      {
        key: 'delivery.review_single_party',
        label: 'Review one-party resends',
        kind: 'boolean',
        description:
          'Whether resending to a single party from its record must pass the wizard’s design and email steps. Bulk sends always do.',
        operational: false,
        level: 'system',
        concert: true,
      },
      {
        key: 'admin.typed_confirm_above',
        min: 0,
        label: 'Typed confirmation above (rows)',
        kind: 'number',
        description:
          'An irreversible command touching more rows than this needs its confirmation phrase typed out.',
        operational: false,
        level: 'system',
        concert: true,
      },
      {
        key: 'scheduler.tick_minutes',
        /**
         * 1–59 because the pg_cron schedule is "every N minutes" in cron's
         * minute field, which means nothing past 59. `schedule_scheduler_jobs()` refuses the
         * same range, so a value outside it fails at save rather than at 3am.
         */
        min: 1,
        max: 59,
        label: 'Scheduler interval (minutes)',
        kind: 'number',
        description:
          'How often pg_cron calls the tick that sends due mail, continues long commands and syncs the inbox. Changing it re-schedules the job.',
        operational: false,
        level: 'system',
      },
      {
        key: 'scheduler.history_days',
        min: 1,
        label: 'Scheduler history (days)',
        kind: 'number',
        description: 'How long pg_cron and pg_net keep their run history before it is trimmed.',
        operational: false,
        level: 'system',
      },
      {
        key: 'inbox.match_fallback_days',
        min: 0,
        label: 'Reply match window (days)',
        kind: 'number',
        description:
          'A reply that lost its threading headers is matched by sender address alone only within this many days of a message to them.',
        operational: false,
        level: 'system',
      },
      {
        key: 'inbox.sync_budget_seconds',
        min: 1,
        label: 'Inbox sync budget (seconds)',
        kind: 'number',
        description: 'The share of each scheduler tick spent reading the mailbox.',
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

/**
 * Parses the posted string into the type the catalogue declares, and checks it
 * means something.
 *
 * The bounds are not fussiness. `system_settings` is the root of the cascade (and
 * `concerts.defaults` the level below it), so a value accepted here is handed to the dispatcher, the scanner and the
 * entitlement guard — which multiplies `allocation.base_quota` by the active
 * player count. "−1 messages per dispatch" and "3.7 messages a day" are not
 * tight configurations; they are nonsense that fails somewhere far from the
 * screen that accepted it.
 */
export function parseSettingValue(
  spec: SettingSpec,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();

  switch (spec.kind) {
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) return { ok: false, error: `“${text}” is not a number.` };
      if (spec.integer !== false && !Number.isInteger(n)) {
        return { ok: false, error: `${spec.label} is a whole number — “${text}” is not.` };
      }
      // Every whole-number key is read into an `int` somewhere (a pool, a
      // cap, a quota), and a value past that range fails there, far from here.
      if (spec.integer !== false && Math.abs(n) > INT_MAX) {
        return { ok: false, error: `${spec.label} cannot be more than ${INT_MAX}.` };
      }
      if (spec.min !== undefined && n < spec.min) {
        return {
          ok: false,
          error:
            spec.min === 0
              ? `${spec.label} cannot be negative.`
              : `${spec.label} must be at least ${spec.min}; ${n} would leave it doing nothing at all.`,
        };
      }
      if (spec.max !== undefined && n > spec.max) {
        return { ok: false, error: `${spec.label} cannot be more than ${spec.max}.` };
      }
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (text === 'true' || text === 'false') return { ok: true, value: text === 'true' };
      return { ok: false, error: 'Choose on or off.' };
    }
    case 'json': {
      try {
        const value: unknown = JSON.parse(text);
        if (spec.key === 'allocation.extras_policy' && !isExtrasPolicy(value)) {
          return {
            ok: false,
            error:
              'An extras policy is REVIEW or AUTO_FCFS, or one per audience: {"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"}.',
          };
        }
        return { ok: true, value };
      } catch {
        return {
          ok: false,
          error:
            'That is not valid JSON. An extras policy looks like {"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"}.',
        };
      }
    }
    default: {
      if (spec.values) {
        const upper = text.toUpperCase();
        if (!spec.values.includes(upper)) {
          return { ok: false, error: `${spec.label} is one of ${spec.values.join(', ')}.` };
        }
        return { ok: true, value: upper };
      }
      if (spec.format === 'timestamp') {
        // An instant needs a zone: a bare "2026-11-20T23:00" would be read in
        // the server's zone, never the concert's (spec/domain.md §6.1).
        const at = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? new Date(text) : new Date(Number.NaN);
        if (Number.isNaN(at.getTime())) {
          return {
            ok: false,
            error: `${spec.label} is a timestamp with its zone, for example 2026-11-20T23:00:00+08:00.`,
          };
        }
        return { ok: true, value: at.toISOString() };
      }
      return { ok: true, value: text };
    }
  }
}

/** `int4`'s ceiling. Not an operational value: the width of the column a count lands in. */
const INT_MAX = 2_147_483_647;

const POLICIES = ['REVIEW', 'AUTO_FCFS'];

/**
 * One policy for every audience, or an object keyed by audience mode —
 * `resolve_setting()` picks from the object by the segment's own mode, at any
 * level. Anything else reaches `segment_pool()` as a policy it cannot read.
 */
function isExtrasPolicy(value: unknown): boolean {
  if (typeof value === 'string') return POLICIES.includes(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([mode, policy]) => ['PLAYER_INVITED', 'PUBLIC'].includes(mode) && POLICIES.includes(policy as string))
  );
}
