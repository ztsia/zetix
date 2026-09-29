/**
 * Home's setup checklist (spec/v3.md §29.2, §29.3): what is still missing for
 * each phase of a concert, as sentences an organiser can act on.
 *
 * Pure: the page gathers the facts, this decides what they mean, so the rules
 * are tested without a database. It replaces the Overview's list of gaps
 * (spec/admin.md §14.1), which is the "before registration" phase here.
 *
 * **Items are links, not actions** (spec/v3.md §28): each names the screen
 * where it is fixed, so a viewer sees the same list. The one item with a fix
 * that needs no screen — checking every address — names a command, and the
 * page hides that button from a viewer.
 */

export type SegmentFacts = {
  id: number;
  name: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  /** A capacity resolves at some level of the cascade. */
  hasCapacity: boolean;
  /** Only asked of a player-invited segment. */
  hasBaseQuota: boolean;
  /** `designForSegment()` finds a ticket design. */
  hasDesign: boolean;
  /** A registration form for it has been opened (OPEN or CLOSED, not DRAFT). */
  formOpened: boolean;
  /** Live parties, however they arrived — an import counts as registration. */
  parties: number;
};

export type ShowFacts = {
  id: number;
  name: string;
  hasHall: boolean;
  /** Σ segment capacity above the hall (decision 21's "N over"). */
  over: number;
  hasStart: boolean;
  hasEnd: boolean;
  segments: SegmentFacts[];
  /** Active operator accounts assigned to this show. */
  operators: number;
  /** The show's feedback form, by its most advanced status. */
  feedback: 'none' | 'DRAFT' | 'OPEN' | 'CLOSED';
};

export type ChecklistFacts = {
  concertId: number;
  hasTimezone: boolean;
  shows: ShowFacts[];
  /** Template keys with no row in `email_templates`. */
  templatesMissing: string[];
  /** Parties flagged `SUSPICIOUS_ADDRESS`, and live parties never checked. */
  addresses: { suspicious: number; unchecked: number };
  hasBooklet: boolean;
  hasPracticalInfo: boolean;
};

export type ChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  /** What is missing, when it is not done: the shows or segments by name. */
  detail: string | null;
  href: string;
  /** A command that fixes it from Home, for an admin. */
  fix?: 'audience.check_address';
};

export type ChecklistPhase = {
  id: 'registration' | 'tickets' | 'show' | 'after';
  label: string;
  items: ChecklistItem[];
};

const quote = (name: string) => `“${name}”`;

/** "“A”, “B” and 2 more" — enough to find them, short enough for one line. */
export function nameList(names: string[], shown = 3): string {
  const quoted = names.map(quote);
  if (quoted.length <= shown) {
    return quoted.length <= 1
      ? (quoted[0] ?? '')
      : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  }
  return `${quoted.slice(0, shown).join(', ')} and ${quoted.length - shown} more`;
}

function item(
  id: string,
  label: string,
  missing: string[],
  href: string,
  empty: string | null = null,
): ChecklistItem {
  // `empty` is what to say when there is nothing to check yet (no shows at
  // all): not done, because the thing it checks does not exist.
  if (empty !== null) return { id, label, done: false, detail: empty, href };
  return {
    id,
    label,
    done: missing.length === 0,
    detail: missing.length === 0 ? null : `Missing for ${nameList(missing)}.`,
    href,
  };
}

export function buildChecklist(facts: ChecklistFacts): ChecklistPhase[] {
  const base = `/admin/concerts/${facts.concertId}`;
  const shows = facts.shows;
  const segments = shows.flatMap((show) =>
    show.segments.map((segment) => ({ show, segment, label: `${show.name} · ${segment.name}` })),
  );
  const noShows = shows.length === 0 ? 'No shows yet.' : null;
  const noSegments = noShows ?? (segments.length === 0 ? 'No segments yet.' : null);
  const playerSegments = segments.filter((s) => s.segment.audienceMode === 'PLAYER_INVITED');

  const overHall = shows.filter((show) => show.over > 0);
  const hall: ChecklistItem = item(
    'hall',
    'Every show has a hall capacity',
    shows.filter((show) => !show.hasHall).map((show) => show.name),
    `${base}/shows`,
    noShows,
  );
  if (hall.done && overHall.length > 0) {
    hall.done = false;
    hall.detail = `${nameList(overHall.map((show) => show.name))} ${
      overHall.length === 1 ? 'has' : 'have'
    } more seats in segments than the hall holds.`;
  }

  const registration: ChecklistItem[] = [
    {
      id: 'timezone',
      label: 'The concert has a timezone',
      done: facts.hasTimezone,
      detail: facts.hasTimezone ? null : 'No show time can be stored or shown without one.',
      href: `${base}/setup`,
    },
    hall,
    item(
      'start',
      'Every show has a start time',
      shows.filter((show) => !show.hasStart).map((show) => show.name),
      `${base}/shows`,
      noShows,
    ),
    item(
      'segments',
      'Every show has a segment',
      shows.filter((show) => show.segments.length === 0).map((show) => show.name),
      `${base}/shows`,
      noShows,
    ),
    item(
      'capacity',
      'Every segment has a capacity',
      segments.filter((s) => !s.segment.hasCapacity).map((s) => s.label),
      `${base}/shows`,
      noSegments,
    ),
  ];
  if (playerSegments.length > 0) {
    registration.push(
      item(
        'quota',
        'Every player-invited segment has a base quota',
        playerSegments.filter((s) => !s.segment.hasBaseQuota).map((s) => s.label),
        `${base}/shows`,
      ),
    );
  }
  registration.push(
    item(
      'forms',
      'Registration is open for every segment',
      segments
        .filter((s) => !s.segment.formOpened && s.segment.parties === 0)
        .map((s) => s.label),
      `${base}/forms`,
      noSegments,
    ),
  );

  const { suspicious, unchecked } = facts.addresses;
  const addressDetail = [
    suspicious > 0 ? `${suspicious} ${suspicious === 1 ? 'party has' : 'parties have'} a suspicious address` : null,
    unchecked > 0 ? `${unchecked} ${unchecked === 1 ? 'party has' : 'parties have'} never been checked` : null,
  ]
    .filter(Boolean)
    .join('; ');

  const tickets: ChecklistItem[] = [
    item(
      'design',
      'Every segment has a ticket design',
      segments.filter((s) => !s.segment.hasDesign).map((s) => s.label),
      `${base}/tickets/templates`,
      noSegments,
    ),
    {
      id: 'templates',
      label: 'Every email template exists',
      done: facts.templatesMissing.length === 0,
      detail:
        facts.templatesMissing.length === 0
          ? null
          : `${facts.templatesMissing.length} missing. Opening Email templates creates them with default wording.`,
      href: `${base}/email/templates`,
    },
    {
      id: 'addresses',
      label: 'Address checks are clean',
      done: suspicious === 0 && unchecked === 0,
      detail: addressDetail ? `${addressDetail}.` : null,
      href: `${base}/audience?view=suspicious-address`,
      ...(unchecked > 0 ? { fix: 'audience.check_address' as const } : {}),
    },
  ];

  const show: ChecklistItem[] = [
    item(
      'operators',
      'Every show has an operator assigned',
      shows.filter((s) => s.operators === 0).map((s) => s.name),
      `${base}/operators`,
      noShows,
    ),
    {
      id: 'booklet',
      label: 'The booklet is uploaded',
      done: facts.hasBooklet,
      detail: null,
      href: `${base}/portal`,
    },
    {
      id: 'practical',
      label: 'Practical info is written',
      done: facts.hasPracticalInfo,
      detail: null,
      href: `${base}/portal`,
    },
    item(
      'end',
      'Every show has an end time',
      shows.filter((s) => !s.hasEnd).map((s) => s.name),
      `${base}/shows`,
      noShows,
    ),
  ];

  const after: ChecklistItem[] = [
    item(
      'feedback',
      'Every show has a feedback form open',
      shows.filter((s) => s.feedback !== 'OPEN').map((s) => s.name),
      `${base}/feedback`,
      noShows,
    ),
  ];

  return [
    { id: 'registration', label: 'Before registration', items: registration },
    { id: 'tickets', label: 'Before tickets', items: tickets },
    { id: 'show', label: 'Before the show', items: show },
    { id: 'after', label: 'After the show', items: after },
  ];
}

// ---------------------------------------------------------------------------
// The scheduler heartbeat (spec/v3.md §27.2)
// ---------------------------------------------------------------------------

export type HeartbeatInput = {
  startedAt: string;
  error: string | null;
} | null;

export type HeartbeatState =
  | { kind: 'unscheduled' }
  | { kind: 'never' }
  | { kind: 'stale'; at: string; minutesAgo: number }
  | { kind: 'failed'; at: string; error: string }
  | { kind: 'ok'; at: string };

/**
 * How the last tick reads. §27.2 wants a warning once the newest tick is older
 * than three ticks. An unset `scheduler.tick_minutes` means pg_cron has not
 * been scheduled (`local.md` §16), which is a setup step, not a failure — so
 * it says that rather than warning.
 */
export function heartbeatState(
  heartbeat: HeartbeatInput,
  tickMinutes: number | null,
  now: Date,
): HeartbeatState {
  if (tickMinutes === null || !(tickMinutes > 0)) return { kind: 'unscheduled' };
  if (!heartbeat) return { kind: 'never' };
  const minutesAgo = Math.floor((now.getTime() - new Date(heartbeat.startedAt).getTime()) / 60_000);
  if (minutesAgo > 3 * tickMinutes) return { kind: 'stale', at: heartbeat.startedAt, minutesAgo };
  if (heartbeat.error) return { kind: 'failed', at: heartbeat.startedAt, error: heartbeat.error };
  return { kind: 'ok', at: heartbeat.startedAt };
}
