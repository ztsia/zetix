import { describe, expect, it } from 'vitest';
import {
  planImport,
  type PlanContext,
  type PlayerMatch,
  type SheetRow,
} from '@/lib/import/plan';
import { parseMappingProfile, type MappingProfile } from '@/lib/import/profile';

/**
 * The planner is the whole correctness surface of module `C`
 * (spec/import.md §9.2, §9.4, §9.5).
 *
 * These tests carry no database: the planner is pure by construction, and the
 * things worth proving here — that a party is grouped the way §9.2 says, and
 * that the three `claim_seats()` properties §9.5 names are handled *before* the
 * call rather than discovered after it — are all decisions the planner makes
 * alone. The commit path is exercised against real Postgres separately.
 */

const HEADERS = {
  ts: 'Timestamp',
  contact: 'Contact Name',
  email: 'Contact Email',
  name: 'Attendee Name',
  type: 'Ticket Type',
} as const;

function profile(over: Partial<Record<string, unknown>> = {}): MappingProfile {
  return parseMappingProfile({
    header_row: 1,
    columns: {
      requested_at: HEADERS.ts,
      contact_name: HEADERS.contact,
      contact_email: HEADERS.email,
      attendee_name: HEADERS.name,
      allocation_type: HEADERS.type,
    },
    allocation_type_values: { BASE: ['Allocated'], EXTRA: ['Extra'] },
    default_allocation_type: 'EXTRA',
    ...over,
  });
}

/**
 * Every number a caller would resolve through the cascade is a parameter here,
 * never a default — the same rule the allocation fixtures follow. A context that
 * quietly defaulted `baseQuota` would hide the very arithmetic these tests exist
 * to pin down.
 */
function context(over: Partial<PlanContext> = {}): PlanContext {
  return {
    audienceMode: 'PLAYER_INVITED',
    extrasPolicy: 'REVIEW',
    baseQuota: 2,
    maxTicketsPerResponse: null,
    openSeats: 100,
    extrasPool: 100,
    baseAlreadyClaimed: new Map(),
    playersWithExistingRegistration: new Set(),
    existingParties: new Map(),
    playerMatches: new Map(),
    playerOverrides: new Map(),
    ...over,
  };
}

let nextRow = 2;
function row(cells: Record<string, string>, rowNumber?: number): SheetRow {
  return { rowNumber: rowNumber ?? nextRow++, cells };
}

const match = (playerId: number, fullName = 'Player'): PlayerMatch => ({
  playerId,
  fullName,
  confidence: 1,
  needsConfirmation: false,
});

const codes = (plan: ReturnType<typeof planImport>) => plan.findings.map((f) => f.code);

describe('grouping (§9.2)', () => {
  it('groups rows sharing contact email and timestamp into one party', () => {
    const at = '2026-09-01T10:00:00Z';
    const plan = planImport(
      [
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Bob Tan', [HEADERS.type]: 'Extra' }, 3),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: '', [HEADERS.type]: 'Extra' }, 4),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(plan.counts.parties).toBe(1);
    expect(plan.counts.seats).toBe(3);
    expect(plan.largestParty).toBe(3);
    expect(plan.parties[0].rowNumbers).toEqual([2, 3, 4]);
  });

  /**
   * The reason the key is a pair. This is the case that decided it: one person,
   * two rounds. Grouping on email alone would merge them into one oversized
   * party and send one email for seats requested a week apart.
   */
  it('keeps the same email at two different timestamps as two registrations', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: '2026-09-08T10:00:00Z', [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Carol Tan', [HEADERS.type]: 'Extra' }, 3),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(plan.counts.parties).toBe(2);
    expect(plan.largestParty).toBe(1);
  });

  it('lets a mapped group column override the rule outright', () => {
    const p = profile({
      player_match: null,
      columns: {
        requested_at: HEADERS.ts,
        contact_name: HEADERS.contact,
        contact_email: HEADERS.email,
        attendee_name: HEADERS.name,
        allocation_type: HEADERS.type,
        group_key: 'Party',
      },
    });
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Extra', Party: '1' }, 2),
        row({ [HEADERS.ts]: '2026-09-08T11:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Bob', [HEADERS.type]: 'Extra', Party: '1' }, 3),
      ],
      p,
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    // Different timestamps would be two parties under the default rule.
    expect(plan.counts.parties).toBe(1);
    expect(plan.counts.seats).toBe(2);
  });

  it('gives a row with no contact email its own registration, and counts it', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: '', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: '', [HEADERS.name]: 'Bob', [HEADERS.type]: 'Extra' }, 3),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(plan.counts.parties).toBe(2);
    expect(plan.counts.ungrouped).toBe(2);
    expect(codes(plan).filter((c) => c === 'NO_GROUPING_KEY')).toHaveLength(2);
  });

  it('warns when rows in one party disagree on the contact name, and keeps the first', () => {
    const at = '2026-09-01T10:00:00Z';
    const plan = planImport(
      [
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'A. Tan', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'Bob', [HEADERS.type]: 'Extra' }, 3),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(codes(plan)).toContain('PARTY_CONTACT_DISAGREEMENT');
    expect(plan.parties[0].contactName).toBe('Alice Tan');
    expect(plan.counts.parties).toBe(1);
  });

  it('orders parties by requested_at, not by file order', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-08T10:00:00Z', [HEADERS.contact]: 'Later', [HEADERS.email]: 'l@example.com', [HEADERS.name]: 'L', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Earlier', [HEADERS.email]: 'e@example.com', [HEADERS.name]: 'E', [HEADERS.type]: 'Extra' }, 3),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(plan.parties.map((p) => p.contactName)).toEqual(['Earlier', 'Later']);
  });
});

describe('what claim_seats() will not infer (§9.5)', () => {
  /**
   * The landmine. The engine sets the base allowance to zero unless the segment
   * is PLAYER_INVITED *and* a player is linked, so a BASE seat in a public
   * segment is waitlisted rather than refused — a public file mapped as BASE
   * would waitlist the whole audience and return success.
   */
  it('refuses a BASE row in a public segment rather than letting it waitlist silently', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Allocated' }, 2),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(codes(plan)).toContain('BASE_IN_PUBLIC_SEGMENT');
    expect(plan.counts.blocking).toBeGreaterThan(0);
    expect(plan.parties[0].blocked).toBe(true);
    // Blocked parties contribute no seats to the commit.
    expect(plan.counts.seats).toBe(0);
  });

  it('blocks a value the profile maps to neither BASE nor EXTRA', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Complimentary' }, 2),
      ],
      profile({ player_match: null }),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(codes(plan)).toContain('ALLOCATION_TYPE_UNMAPPED');
    expect(plan.parties[0].blocked).toBe(true);
  });

  it('falls back to the profile default when no allocation column is mapped', () => {
    const p = parseMappingProfile({
      columns: {
        requested_at: HEADERS.ts,
        contact_name: HEADERS.contact,
        contact_email: HEADERS.email,
        attendee_name: HEADERS.name,
      },
      default_allocation_type: 'EXTRA',
    });
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'Alice' }, 2)],
      p,
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null }),
    );

    expect(plan.counts.blocking).toBe(0);
    expect(plan.parties[0].seats[0].allocationType).toBe('EXTRA');
  });

  /** The engine waitlists surplus base; §9.4 promises it becomes EXTRA. */
  it('promotes base seats past the quota to extra, in row order', () => {
    const at = '2026-09-01T10:00:00Z';
    const plan = planImport(
      [
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'One', [HEADERS.type]: 'Allocated' }, 2),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'Two', [HEADERS.type]: 'Allocated' }, 3),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'Three', [HEADERS.type]: 'Allocated' }, 4),
      ],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ baseQuota: 2, playerMatches: new Map([['p@example.com', match(7)]]) }),
    );

    const seats = plan.parties[0].seats;
    expect(seats.map((s) => s.allocationType)).toEqual(['BASE', 'BASE', 'EXTRA']);
    expect(seats[2].promotedFromBase).toBe(true);
    expect(plan.counts.promotedToExtra).toBe(1);
    expect(codes(plan)).toContain('BASE_SURPLUS_PROMOTED');
  });

  /**
   * A quota is per player across every registration they hold (§7.6), so a
   * player who took their base in round 1 has none left in round 2. Counting
   * only within the file would hand out a second full quota.
   */
  it('counts base already claimed in the database against the quota', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-08T10:00:00Z', [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'Second round', [HEADERS.type]: 'Allocated' }, 2),
      ],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        baseQuota: 2,
        baseAlreadyClaimed: new Map([[7, 2]]),
        playerMatches: new Map([['p@example.com', match(7)]]),
      }),
    );

    expect(plan.parties[0].seats[0].allocationType).toBe('EXTRA');
    expect(plan.counts.promotedToExtra).toBe(1);
  });

  it('spends one quota across two parties held by the same player', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'R1', [HEADERS.type]: 'Allocated' }, 2),
        row({ [HEADERS.ts]: '2026-09-08T10:00:00Z', [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'R2', [HEADERS.type]: 'Allocated' }, 3),
      ],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ baseQuota: 1, playerMatches: new Map([['p@example.com', match(7)]]) }),
    );

    expect(plan.counts.parties).toBe(2);
    expect(plan.parties[0].seats[0].allocationType).toBe('BASE');
    expect(plan.parties[1].seats[0].allocationType).toBe('EXTRA');
  });
});

describe('player matching (§9.3, §9.4)', () => {
  it('blocks a party whose player does not match', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'nobody@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ playerMatches: new Map() }),
    );

    expect(codes(plan)).toContain('PLAYER_NOT_MATCHED');
    expect(plan.parties[0].blocked).toBe(true);
  });

  it('blocks a fuzzy match below the confirmation threshold', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'NAME_FUZZY' } }),
      context({
        playerMatches: new Map([
          ['p@example.com', { playerId: 7, fullName: 'Pat Lim', confidence: 0.7, needsConfirmation: true }],
        ]),
      }),
    );

    expect(codes(plan)).toContain('PLAYER_MATCH_UNCONFIRMED');
    expect(plan.parties[0].blocked).toBe(true);
  });

  it('carries the cell value and the suggestion on an unconfirmed finding', () => {
    // The dry-run screen keys its choice by the cell value and offers the
    // suggestion as the one-click answer, so both have to be data on the
    // finding rather than English inside `message`.
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'NAME_FUZZY' } }),
      context({
        playerMatches: new Map([
          ['p@example.com', { playerId: 7, fullName: 'Pat Lim', confidence: 0.39, needsConfirmation: true }],
        ]),
      }),
    );

    const finding = plan.findings.find((f) => f.code === 'PLAYER_MATCH_UNCONFIRMED');
    expect(finding?.match).toEqual({
      needle: 'p@example.com',
      playerId: 7,
      playerName: 'Pat Lim',
      confidence: 0.39,
    });
  });

  it('names the cell value on an unmatched finding, so one can be chosen for it', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'nobody@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ playerMatches: new Map() }),
    );

    expect(plan.findings.find((f) => f.code === 'PLAYER_NOT_MATCHED')?.match).toEqual({
      needle: 'nobody@example.com',
    });
  });

  it('an override clears an unconfirmed match', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'NAME_FUZZY' } }),
      context({
        playerMatches: new Map([
          ['p@example.com', { playerId: 7, fullName: 'Pat Lim', confidence: 0.39, needsConfirmation: true }],
        ]),
        playerOverrides: new Map([['p@example.com', { playerId: 7, fullName: 'Pat Lim' }]]),
      }),
    );

    expect(codes(plan)).not.toContain('PLAYER_MATCH_UNCONFIRMED');
    expect(plan.parties[0].blocked).toBe(false);
    expect(plan.parties[0].playerId).toBe(7);
  });

  it('an override rescues a party nothing matched at all', () => {
    // The case that most needs it: a name the roster spells differently, which
    // no threshold can rescue.
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'nobody@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        playerMatches: new Map(),
        playerOverrides: new Map([['nobody@example.com', { playerId: 9, fullName: 'Wei Ling' }]]),
      }),
    );

    expect(codes(plan)).not.toContain('PLAYER_NOT_MATCHED');
    expect(plan.parties[0].blocked).toBe(false);
    expect(plan.parties[0].playerId).toBe(9);
    expect(plan.parties[0].playerName).toBe('Wei Ling');
  });

  it('an override can send a party to a different player than the suggestion', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'NAME_FUZZY' } }),
      context({
        playerMatches: new Map([
          ['p@example.com', { playerId: 7, fullName: 'Pat Lim', confidence: 0.39, needsConfirmation: true }],
        ]),
        playerOverrides: new Map([['p@example.com', { playerId: 12, fullName: 'Someone Else' }]]),
      }),
    );

    expect(plan.parties[0].playerId).toBe(12);
    expect(plan.parties[0].playerName).toBe('Someone Else');
  });

  it('an override is still refused a player who already registered (§7.6)', () => {
    // Choosing by hand must not be a way round the one-registration-per-player
    // rule — the check reads the draft, not the fuzzy match.
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'nobody@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        playerMatches: new Map(),
        playerOverrides: new Map([['nobody@example.com', { playerId: 9, fullName: 'Wei Ling' }]]),
        playersWithExistingRegistration: new Set([9]),
      }),
    );

    expect(codes(plan)).toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan.parties[0].blocked).toBe(true);
  });

  it('blocks a player who already has a registration for this show', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'X', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'X', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        playerMatches: new Map([['p@example.com', match(7, 'Pat Lim')]]),
        playersWithExistingRegistration: new Set([7]),
      }),
    );

    expect(codes(plan)).toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan.parties[0].blocked).toBe(true);
  });
});

describe('validation levels (§9.4)', () => {
  const publicCtx = () =>
    context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null });
  const publicProfile = () => profile({ player_match: null });

  it('treats a blank attendee name as info and leaves the name null for the engine', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'a@example.com', [HEADERS.name]: '   ', [HEADERS.type]: 'Extra' }, 2)],
      publicProfile(),
      publicCtx(),
    );

    const info = plan.findings.find((f) => f.code === 'PLACEHOLDER_NAME');
    expect(info?.level).toBe('INFO');
    expect(info?.message).toContain('Guest of Alice Tan');
    // Null, not the built string: claim_seats() generates it (decision 32).
    expect(plan.parties[0].seats[0].fullName).toBeNull();
    expect(plan.counts.placeholderNames).toBe(1);
    expect(plan.counts.blocking).toBe(0);
  });

  it('warns on a malformed email but still imports the seat', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'Alice', [HEADERS.email]: 'not-an-email', [HEADERS.name]: 'Alice', [HEADERS.type]: 'Extra' }, 2)],
      publicProfile(),
      publicCtx(),
    );

    expect(codes(plan)).toContain('CONTACT_EMAIL_MALFORMED');
    expect(plan.counts.blocking).toBe(0);
    expect(plan.counts.seats).toBe(1);
  });

  /**
   * A guest typed `may _zxample@yahoo.com`. It imported with a malformed warning
   * and was then *delivered* — to `_zxample@yahoo.com`, because an address parser
   * splits the header on the space and keeps the last token, which was a real
   * address belonging to somebody else. A bounce would have been the good
   * outcome.
   *
   * So the space comes out here, unconditionally. It is a guess, and the only
   * one available: an address with a space cannot be delivered as typed, so the
   * choice is repair or certain failure, and a wrong repair bounces visibly.
   */
  it('removes a space from inside an address rather than importing it', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'May', [HEADERS.email]: 'may _zxample@yahoo.com', [HEADERS.name]: 'May', [HEADERS.type]: 'Extra' }, 2)],
      publicProfile(),
      publicCtx(),
    );

    expect(plan.parties[0].contactEmail).toBe('may_zxample@yahoo.com');
    // Repaired, so there is nothing left to warn about.
    expect(codes(plan)).not.toContain('CONTACT_EMAIL_MALFORMED');
    expect(plan.counts.blocking).toBe(0);
  });

  it('still warns when removing the spaces does not make it an address', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'May', [HEADERS.email]: 'not an email', [HEADERS.name]: 'May', [HEADERS.type]: 'Extra' }, 2)],
      publicProfile(),
      publicCtx(),
    );

    expect(codes(plan)).toContain('CONTACT_EMAIL_MALFORMED');
    expect(plan.counts.seats).toBe(1);
  });

  it('warns on a duplicate attendee email within the file', () => {
    const p = parseMappingProfile({
      columns: {
        requested_at: HEADERS.ts,
        contact_name: HEADERS.contact,
        contact_email: HEADERS.email,
        attendee_name: HEADERS.name,
        attendee_email: 'Attendee Email',
      },
      default_allocation_type: 'EXTRA',
    });
    const plan = planImport(
      [
        row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'A', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'One', 'Attendee Email': 'dup@example.com' }, 2),
        row({ [HEADERS.ts]: '2026-09-02T10:00:00Z', [HEADERS.contact]: 'B', [HEADERS.email]: 'b@example.com', [HEADERS.name]: 'Two', 'Attendee Email': 'DUP@example.com' }, 3),
      ],
      p,
      publicCtx(),
    );

    // Case-folded by the lowercase_emails transform, so the duplicate is caught.
    expect(codes(plan)).toContain('DUPLICATE_EMAIL_IN_FILE');
    expect(plan.counts.seats).toBe(2);
  });

  it('warns when a party exceeds the configured cap without blocking it', () => {
    const at = '2026-09-01T10:00:00Z';
    const plan = planImport(
      [
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'A', [HEADERS.email]: 'a@example.com', [HEADERS.name]: '1', [HEADERS.type]: 'Extra' }, 2),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'A', [HEADERS.email]: 'a@example.com', [HEADERS.name]: '2', [HEADERS.type]: 'Extra' }, 3),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'A', [HEADERS.email]: 'a@example.com', [HEADERS.name]: '3', [HEADERS.type]: 'Extra' }, 4),
      ],
      publicProfile(),
      context({
        audienceMode: 'PUBLIC',
        extrasPolicy: 'AUTO_FCFS',
        baseQuota: null,
        maxTicketsPerResponse: 2,
      }),
    );

    const f = plan.findings.find((x) => x.code === 'PARTY_OVER_CAP');
    expect(f?.level).toBe('WARNING');
    expect(plan.counts.blocking).toBe(0);
    expect(plan.counts.seats).toBe(3);
  });

  it('blocks a row with no readable timestamp rather than substituting import time', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: 'not a date', [HEADERS.contact]: 'A', [HEADERS.email]: 'a@example.com', [HEADERS.name]: 'A', [HEADERS.type]: 'Extra' }, 2)],
      publicProfile(),
      publicCtx(),
    );

    expect(codes(plan)).toContain('REQUESTED_AT_UNREADABLE');
    expect(plan.counts.parties).toBe(0);
  });

  it('blocks when the import needs more seats than the segment has open', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ [HEADERS.ts]: `2026-09-0${i + 1}T10:00:00Z`, [HEADERS.contact]: `C${i}`, [HEADERS.email]: `c${i}@example.com`, [HEADERS.name]: `N${i}`, [HEADERS.type]: 'Extra' }, i + 2),
    );
    const plan = planImport(
      rows,
      publicProfile(),
      context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null, openSeats: 3 }),
    );

    const f = plan.findings.find((x) => x.code === 'CAPACITY_EXCEEDED');
    expect(f?.level).toBe('BLOCKING');
    expect(f?.message).toContain('1 seats over');
  });

  /**
   * Under REVIEW an extras request holds as PENDING_REVIEW and consumes no
   * seats (§7.4). Counting them against capacity at intake would block an
   * import that the review screen exists to decide later.
   */
  it('does not count REVIEW extras against capacity at intake', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ [HEADERS.ts]: `2026-09-01T10:0${i}:00Z`, [HEADERS.contact]: `C${i}`, [HEADERS.email]: `c${i}@example.com`, [HEADERS.name]: `N${i}`, [HEADERS.type]: 'Extra' }, i + 2),
    );
    const matches = new Map(rows.map((r, i) => [`c${i}@example.com`, match(100 + i)]));
    const plan = planImport(
      rows,
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ extrasPolicy: 'REVIEW', openSeats: 0, playerMatches: matches }),
    );

    expect(codes(plan)).not.toContain('CAPACITY_EXCEEDED');
    expect(plan.counts.extraSeats).toBe(10);
  });
});

describe('predicting what the engine will do (§9.4, §9.6)', () => {
  const publicRows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row(
        {
          [HEADERS.ts]: `2026-09-01T10:0${i}:00Z`,
          [HEADERS.contact]: `C${i}`,
          [HEADERS.email]: `c${i}@example.com`,
          [HEADERS.name]: `N${i}`,
          [HEADERS.type]: 'Extra',
        },
        i + 2,
      ),
    );

  /**
   * The finding this exists for: `open_seats` and `extras_pool` are different
   * numbers, and extras draw on the pool. Sizing against open seats reported a
   * file that fits, then the engine waitlisted all of it under a success banner.
   */
  it('sizes extras against the extras pool, not against open seats', () => {
    const plan = planImport(
      publicRows(8),
      profile({ player_match: null }),
      context({
        audienceMode: 'PUBLIC',
        extrasPolicy: 'AUTO_FCFS',
        baseQuota: null,
        openSeats: 10,
        // Eight base seats are still owed to players who have not claimed, so
        // only two of the ten open seats are actually available to extras.
        extrasPool: 2,
      }),
    );

    expect(codes(plan)).toContain('CAPACITY_EXCEEDED');
    expect(plan.findings.find((f) => f.code === 'CAPACITY_EXCEEDED')?.level).toBe('BLOCKING');
  });

  it('predicts confirmed and waitlisted rather than only counting seats', () => {
    const plan = planImport(
      publicRows(5),
      profile({ player_match: null }),
      context({
        audienceMode: 'PUBLIC',
        extrasPolicy: 'AUTO_FCFS',
        baseQuota: null,
        openSeats: 100,
        extrasPool: 3,
      }),
    );

    expect(plan.counts.predictedConfirmed).toBe(3);
    expect(plan.counts.predictedWaitlisted).toBe(2);
    expect(codes(plan)).toContain('SEATS_WILL_WAITLIST');
  });

  it('predicts REVIEW extras as pending, consuming nothing', () => {
    const plan = planImport(
      publicRows(6),
      profile({ player_match: null }),
      context({
        audienceMode: 'PUBLIC',
        extrasPolicy: 'REVIEW',
        baseQuota: null,
        openSeats: 0,
        extrasPool: 0,
      }),
    );

    expect(plan.counts.predictedPending).toBe(6);
    expect(plan.counts.predictedWaitlisted).toBe(0);
    expect(codes(plan)).not.toContain('CAPACITY_EXCEEDED');
  });

  it('names the matched player on the party, for the report to show', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-01T10:00:00Z', [HEADERS.contact]: 'P', [HEADERS.email]: 'p@example.com', [HEADERS.name]: 'Guest', [HEADERS.type]: 'Extra' }, 2)],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({ playerMatches: new Map([['p@example.com', match(7, 'Pat Lim')]]) }),
    );

    expect(plan.parties[0].playerName).toBe('Pat Lim');
  });
});

/**
 * §9.2: re-importing a cumulative export.
 *
 * Registration runs in rounds and a Google Forms export is cumulative, so the
 * importer is handed rows it has already committed every round. These pin the
 * difference between "already there" and "wrong", which is the whole reason the
 * skip is INFO rather than blocking.
 */
describe('re-import dedup (§9.2)', () => {
  const at = '2026-09-01T10:00:00Z';
  const key = `alice@example.com|${new Date(at).toISOString()}`;

  const aliceRows = () => [
    row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Extra' }),
    row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Bob Tan', [HEADERS.type]: 'Extra' }),
  ];

  const publicCtx = (over: Partial<PlanContext> = {}) =>
    context({ audienceMode: 'PUBLIC', extrasPolicy: 'AUTO_FCFS', baseQuota: null, ...over });

  it('skips a party already imported, and does not block the run', () => {
    const plan = planImport(
      aliceRows(),
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: false }]]) }),
    );

    expect(codes(plan)).toContain('PARTY_ALREADY_IMPORTED');
    expect(plan.counts.blocking).toBe(0);
    expect(plan.parties[0].skipped).toBe(true);
    expect(plan.counts.skippedParties).toBe(1);
  });

  /**
   * The seats of a skipped party must leave the counts *and* the prediction.
   * Leaving them in is the failure that looks like success: a second import of
   * an unchanged file reporting seats it will not write, against a pool it will
   * not spend.
   */
  it('does not count or predict seats it will not write', () => {
    const plan = planImport(
      aliceRows(),
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: false }]]) }),
    );

    expect(plan.counts.seats).toBe(0);
    expect(plan.counts.predictedConfirmed).toBe(0);
  });

  it('imports the new rows of an appended sheet and skips the old ones', () => {
    const plan = planImport(
      [
        ...aliceRows(),
        row({ [HEADERS.ts]: '2026-09-02T10:00:00Z', [HEADERS.contact]: 'Carol Lim', [HEADERS.email]: 'carol@example.com', [HEADERS.name]: 'Carol Lim', [HEADERS.type]: 'Extra' }),
      ],
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: false }]]) }),
    );

    expect(plan.counts.parties).toBe(2);
    expect(plan.counts.skippedParties).toBe(1);
    expect(plan.counts.seats).toBe(1);
    expect(plan.parties.filter((p) => !p.skipped)[0].contactName).toBe('Carol Lim');
  });

  /**
   * A seat appended to a response that is already committed. Still skipped —
   * after commit the database is the source of truth (§9.1) and the admin may
   * have edited this party since — but it must say so rather than pass as INFO.
   */
  it('warns rather than informs when the party size has changed', () => {
    const plan = planImport(
      aliceRows(),
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 3, cancelled: false }]]) }),
    );

    expect(plan.findings.find((f) => f.code === 'PARTY_SIZE_CHANGED')?.level).toBe('WARNING');
    expect(codes(plan)).not.toContain('PARTY_ALREADY_IMPORTED');
    expect(plan.parties[0].skipped).toBe(true);
    expect(plan.counts.blocking).toBe(0);
  });

  /**
   * An admin looking at a cancelled party needs to know why the importer will
   * not bring it back, or the skip reads as the importer losing the row.
   */
  it('says so when the party it is skipping was cancelled', () => {
    const plan = planImport(
      aliceRows(),
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: true }]]) }),
    );

    const finding = plan.findings.find((f) => f.code === 'PARTY_ALREADY_IMPORTED');
    expect(finding?.message).toContain('cancelled');
    expect(plan.parties[0].skipped).toBe(true);
  });

  it('has no dedup key without a contact email, so it re-imports and says so', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Extra' })],
      profile({ player_match: null }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: false }]]) }),
    );

    expect(plan.parties[0].dedupKey).toBeNull();
    expect(plan.parties[0].skipped).toBe(false);
    expect(codes(plan)).toContain('NO_GROUPING_KEY');
  });

  /**
   * The interaction that makes appending to one sheet work at all in a player
   * segment. A re-imported party trips §7.6 against the registration it *is*,
   * and blocking there would refuse the newly appended rows with it.
   */
  it('does not block on PLAYER_ALREADY_REGISTERED for a party it is skipping', () => {
    const plan = planImport(
      aliceRows(),
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        existingParties: new Map([[key, { seats: 2, cancelled: false }]]),
        playerMatches: new Map([['alice@example.com', match(9, 'Alice Tan')]]),
        playersWithExistingRegistration: new Set([9]),
      }),
    );

    expect(codes(plan)).not.toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan.counts.blocking).toBe(0);
    expect(plan.parties[0].skipped).toBe(true);
  });

  /** But a genuinely different submission by that player still blocks (§7.6). */
  it('still blocks a different party claiming an already-registered player', () => {
    const plan = planImport(
      [row({ [HEADERS.ts]: '2026-09-05T10:00:00Z', [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Allocated' })],
      profile({ player_match: { column: HEADERS.email, strategy: 'EMAIL' } }),
      context({
        existingParties: new Map([[key, { seats: 2, cancelled: false }]]),
        playerMatches: new Map([['alice@example.com', match(9, 'Alice Tan')]]),
        playersWithExistingRegistration: new Set([9]),
      }),
    );

    expect(codes(plan)).toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan.counts.blocking).toBe(1);
  });

  /**
   * The key is built from the values, not from the grouping key, so a sheet
   * that gained a mapped group column does not re-import everything it already
   * committed under the §9.2 default rule.
   */
  it('recognises a party that is now grouped by an explicit group column', () => {
    const plan = planImport(
      [
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Alice Tan', [HEADERS.type]: 'Extra', Party: 'P1' }),
        row({ [HEADERS.ts]: at, [HEADERS.contact]: 'Alice Tan', [HEADERS.email]: 'alice@example.com', [HEADERS.name]: 'Bob Tan', [HEADERS.type]: 'Extra', Party: 'P1' }),
      ],
      profile({
        player_match: null,
        columns: {
          requested_at: HEADERS.ts,
          contact_name: HEADERS.contact,
          contact_email: HEADERS.email,
          attendee_name: HEADERS.name,
          allocation_type: HEADERS.type,
          group_key: 'Party',
        },
      }),
      publicCtx({ existingParties: new Map([[key, { seats: 2, cancelled: false }]]) }),
    );

    expect(plan.parties[0].skipped).toBe(true);
    expect(codes(plan)).toContain('PARTY_ALREADY_IMPORTED');
  });
});
