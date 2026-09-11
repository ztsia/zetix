import type { AllocationChoice, MappingProfile } from './profile';

/**
 * The pure core of the import (spec/import.md §9.2, §9.4, §9.5).
 *
 * Everything here is a function of its arguments: no database, no clock, no
 * environment. The dry run and the commit run the *same* planner over the same
 * rows, which is what makes "the dry run is where mistakes are caught"
 * (decision 26) a guarantee rather than a hope — a commit cannot decide
 * something the preview did not show.
 */

export type FindingLevel = 'BLOCKING' | 'WARNING' | 'INFO';

export type Finding = {
  level: FindingLevel;
  code: string;
  message: string;
  /** 1-based sheet row. Absent on a file-level finding. */
  rowNumber?: number;
  partyKey?: string;
  /**
   * The player decision this finding is waiting on, for the two codes that can
   * be resolved from the dry-run screen rather than by editing the sheet.
   *
   * The message alone cannot drive that: the screen needs the cell value to key
   * the choice by, and the suggestion to offer as the one-click answer. Carried
   * as data rather than parsed back out of English.
   */
  match?: {
    /** The cell value that was matched on — the key an override is stored under. */
    needle: string;
    /** The best suggestion, when there was one. Absent for PLAYER_NOT_MATCHED. */
    playerId?: number;
    playerName?: string;
    /** `pg_trgm` similarity, 0–1. */
    confidence?: number;
  };
};

export type PlannedSeat = {
  rowNumber: number;
  /**
   * Null is passed through to `claim_seats()`, which generates
   * "Guest of {contact_name}" with `name_source = 'PLACEHOLDER'` itself
   * (decision 32). Import does not build that string — one generator, in the
   * one place every path already goes through.
   */
  fullName: string | null;
  email: string | null;
  allocationType: AllocationChoice;
  /** True when §9.5 promotion moved this seat off a spent base quota. */
  promotedFromBase: boolean;
};

export type PlannedParty = {
  key: string;
  rowNumbers: number[];
  contactName: string;
  contactEmail: string | null;
  requestedAt: Date;
  playerId: number | null;
  /** The matched player's name, so the report can show which one it found. */
  playerName: string | null;
  seats: PlannedSeat[];
  /** A blocking finding somewhere in this party. Any one blocks the whole run. */
  blocked: boolean;
  /**
   * `contact_email|requested_at`, the pair §9.2 groups on and the only identity
   * of a party that survives outside the file. Null when there is no contact
   * email, which is exactly when a party cannot be recognised across imports.
   */
  dedupKey: string | null;
  /**
   * Already in this segment, so this run writes nothing for it (§9.2). Unlike
   * `blocked` it does not stop the run — the party's seats already exist.
   */
  skipped: boolean;
};

/**
 * The parties a run actually writes. Shared so the planner's counts, its
 * capacity prediction and the commit cannot disagree about which parties are
 * live — three filters spelled separately is three places for one to drift.
 */
export function liveParties<T extends { blocked: boolean; skipped: boolean }>(
  parties: readonly T[],
): T[] {
  return parties.filter((p) => !p.blocked && !p.skipped);
}

export type PlayerMatch =
  | { playerId: number; fullName: string; confidence: number; needsConfirmation: boolean }
  | null;

export type PlanContext = {
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  extrasPolicy: 'REVIEW' | 'AUTO_FCFS';
  /** Resolved through the cascade, never a literal. Null in a public segment. */
  baseQuota: number | null;
  /** `form.max_tickets_per_response`, resolved. Null means no cap configured. */
  maxTicketsPerResponse: number | null;
  /** `segmentPool().open_seats` at plan time — what BASE seats draw on. */
  openSeats: number;
  /**
   * `segmentPool().extras_pool` — what EXTRA seats draw on, which is **not** the
   * same number. The pool is open seats minus the base still owed to players who
   * have not claimed it, so sizing extras against `open_seats` predicts a file
   * fits when the engine will waitlist most of it (§7.2).
   */
  extrasPool: number;
  /**
   * Confirmed `BASE` seats this player already holds in this segment, so a
   * player who registered in round 1 does not get a second full quota in round
   * 2. Counted the way `claim_seats()` counts it (§7.6).
   */
  baseAlreadyClaimed: ReadonlyMap<number, number>;
  /** Player ids that already have a registration for this show (§9.4, blocking). */
  playersWithExistingRegistration: ReadonlySet<number>;
  /**
   * Parties already imported into this segment, keyed by `dedupKey` and carrying
   * the seat count they were committed with (§9.2).
   *
   * This is what makes re-uploading a cumulative Google Forms export safe: a
   * round 2 download is round 1 plus the new responses, and without this every
   * round 1 party would be written a second time — a second email, a second set
   * of tickets, and seats spent twice out of a pool sized once.
   */
  existingParties: ReadonlyMap<string, { seats: number }>;
  /**
   * Raw cell value to match, precomputed by the caller. Kept out of the planner
   * because `NAME_FUZZY` is `pg_trgm` similarity, and reimplementing it in
   * TypeScript would give a second answer to the same question.
   */
  playerMatches: ReadonlyMap<string, PlayerMatch>;
  /**
   * Players the admin chose explicitly on the dry-run screen, keyed by cell
   * value (§9.3). Resolved and re-validated by `loadPlayerOverrides`.
   *
   * An override wins over whatever matching produced, including over nothing at
   * all — so it answers `PLAYER_NOT_MATCHED` and `PLAYER_MATCH_UNCONFIRMED`
   * alike. Keyed by cell value rather than by party so that one decision about
   * "Haruto Lim Wei Kang" covers every row that says it, and so that it
   * survives a re-run of the same file.
   */
  playerOverrides: ReadonlyMap<string, { playerId: number; fullName: string }>;
};

export type ImportPlan = {
  parties: PlannedParty[];
  findings: Finding[];
  counts: {
    rows: number;
    parties: number;
    seats: number;
    baseSeats: number;
    extraSeats: number;
    promotedToExtra: number;
    placeholderNames: number;
    /** What the engine is predicted to do with these seats. See {@link predict}. */
    predictedConfirmed: number;
    predictedPending: number;
    predictedWaitlisted: number;
    ungrouped: number;
    /** Parties already in the segment, written by neither this run nor counted in it. */
    skippedParties: number;
    blocking: number;
    warning: number;
    info: number;
  };
  /** Largest party, for the §9.6 grouping line. */
  largestParty: number;
};

/** A parsed sheet row: header to cell text, plus the row's 1-based sheet line. */
export type SheetRow = { rowNumber: number; cells: Record<string, string> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function titlecase(value: string): string {
  return value.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** Applies the profile's transforms. Empty and whitespace-only both become null. */
function cell(
  row: SheetRow,
  column: string | null,
  transforms: MappingProfile['transforms'],
  kind: 'text' | 'email' | 'name' = 'text',
): string | null {
  if (!column) return null;
  const raw = row.cells[column];
  if (raw == null) return null;
  let v = transforms.trimWhitespace ? raw.trim() : raw;
  if (v.trim() === '') return null;
  if (kind === 'email' && transforms.lowercaseEmails) v = v.toLowerCase();
  if (kind === 'name' && transforms.titlecaseNames) v = titlecase(v);
  return v;
}

/**
 * Resolves the sheet's allocation-type text to `BASE` or `EXTRA`.
 *
 * `undefined` means the text matched nothing configured, which §9.4 makes
 * blocking rather than guessing at: `claim_seats()` refuses a missing
 * `allocation_type` outright, and a wrong one spends the wrong seats.
 */
export function resolveAllocationType(
  raw: string | null,
  profile: MappingProfile,
): AllocationChoice | undefined {
  if (!profile.columns.allocationType) return profile.defaultAllocationType;
  if (raw == null) return profile.defaultAllocationType;
  const needle = raw.trim().toLowerCase();
  for (const choice of ['BASE', 'EXTRA'] as const) {
    if (profile.allocationTypeValues[choice].some((v) => v.trim().toLowerCase() === needle)) {
      return choice;
    }
  }
  return undefined;
}

/**
 * Parses the response timestamp. Google Forms exports it as a string in the
 * sheet's own locale; `exceljs` hands back a `Date` for a real date cell, and
 * `parse.ts` stringifies it as ISO, so both arrive here as text.
 */
export function parseRequestedAt(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function planImport(
  rows: readonly SheetRow[],
  profile: MappingProfile,
  context: PlanContext,
): ImportPlan {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  type Draft = {
    key: string;
    rowNumbers: number[];
    contactName: string;
    contactEmail: string | null;
    requestedAt: Date;
    playerId: number | null;
    playerName: string | null;
    seats: PlannedSeat[];
    blocked: boolean;
    dedupKey: string | null;
    skipped: boolean;
  };

  const drafts = new Map<string, Draft>();
  const order: string[] = [];
  const emailFirstSeen = new Map<string, number>();
  let ungrouped = 0;

  for (const row of rows) {
    const t = profile.transforms;
    const contactName = cell(row, profile.columns.contactName, t, 'name');
    const contactEmail = cell(row, profile.columns.contactEmail, t, 'email');
    const requestedRaw = cell(row, profile.columns.requestedAt, t);
    const requestedAt = parseRequestedAt(requestedRaw);
    const groupKeyCell = cell(row, profile.columns.groupKey, t);

    if (!contactName) {
      add({
        level: 'BLOCKING',
        code: 'CONTACT_NAME_MISSING',
        rowNumber: row.rowNumber,
        message:
          'No contact name. It is the identity of the party, and the placeholder every unnamed seat is ticketed under.',
      });
    }
    if (!requestedAt) {
      add({
        level: 'BLOCKING',
        code: 'REQUESTED_AT_UNREADABLE',
        rowNumber: row.rowNumber,
        message: requestedRaw
          ? `Could not read "${requestedRaw}" as a date and time. It is the first-come-first-served ordering key (§7.4).`
          : 'No response timestamp. It is the first-come-first-served ordering key (§7.4), and import time is not a substitute.',
      });
    }

    // A row missing either half of its identity cannot be grouped or ordered,
    // so it is reported and dropped rather than guessed into some party.
    if (!contactName || !requestedAt) continue;

    if (contactEmail && !EMAIL.test(contactEmail)) {
      add({
        level: 'WARNING',
        code: 'CONTACT_EMAIL_MALFORMED',
        rowNumber: row.rowNumber,
        message: `"${contactEmail}" does not look like an email address. Imported and flagged - the ticket still renders, but the blast cannot reach them.`,
      });
    }

    // §9.2: contact_email + requested_at, unless an explicit group column says
    // otherwise. A row with neither is its own registration, counted so the
    // number is never a surprise.
    let key: string;
    if (groupKeyCell) {
      key = `g:${groupKeyCell}`;
    } else if (contactEmail) {
      key = `e:${contactEmail} ${requestedAt.toISOString()}`;
    } else {
      key = `r:${row.rowNumber}`;
      ungrouped += 1;
      add({
        level: 'WARNING',
        code: 'NO_GROUPING_KEY',
        rowNumber: row.rowNumber,
        message:
          'No contact email, so this row cannot be grouped with any other and becomes a registration of its own. Map a group column if it belongs to a party.',
      });
    }

    const attendeeName = cell(row, profile.columns.attendeeName, t, 'name');
    const attendeeEmail = cell(row, profile.columns.attendeeEmail, t, 'email');
    if (attendeeEmail && !EMAIL.test(attendeeEmail)) {
      add({
        level: 'WARNING',
        code: 'ATTENDEE_EMAIL_MALFORMED',
        rowNumber: row.rowNumber,
        message: `"${attendeeEmail}" does not look like an email address. Imported and flagged.`,
      });
    }
    if (attendeeEmail) {
      const seen = emailFirstSeen.get(attendeeEmail);
      if (seen !== undefined && seen !== row.rowNumber) {
        add({
          level: 'WARNING',
          code: 'DUPLICATE_EMAIL_IN_FILE',
          rowNumber: row.rowNumber,
          message: `This email also appears on row ${seen}. Imported and flagged - two seats for one address is legitimate for a couple, and a mistake otherwise.`,
        });
      } else if (seen === undefined) {
        emailFirstSeen.set(attendeeEmail, row.rowNumber);
      }
    }
    if (!attendeeName) {
      add({
        level: 'INFO',
        code: 'PLACEHOLDER_NAME',
        rowNumber: row.rowNumber,
        message: `No attendee name - will ticket as "Guest of ${contactName}".`,
      });
    }

    const typeRaw = cell(row, profile.columns.allocationType, t);
    const resolved = resolveAllocationType(typeRaw, profile);
    let allocationType: AllocationChoice = resolved ?? profile.defaultAllocationType;
    let blockedHere = false;

    if (resolved === undefined) {
      blockedHere = true;
      add({
        level: 'BLOCKING',
        code: 'ALLOCATION_TYPE_UNMAPPED',
        rowNumber: row.rowNumber,
        message: `"${typeRaw}" is not mapped to BASE or EXTRA. Map it on the previous step - claim_seats() refuses a seat with no allocation type, and guessing spends the wrong one.`,
      });
    }

    // §9.5: BASE only ever grants in a PLAYER_INVITED segment with a linked
    // player. In a public segment the engine does not refuse it, it silently
    // waitlists it — so a public file mapped as BASE would waitlist the whole
    // audience and report success. Refused here rather than discovered there.
    if (context.audienceMode === 'PUBLIC' && allocationType === 'BASE') {
      blockedHere = true;
      add({
        level: 'BLOCKING',
        code: 'BASE_IN_PUBLIC_SEGMENT',
        rowNumber: row.rowNumber,
        message:
          'BASE seats exist only in a player-invited segment. In a public segment claim_seats() waitlists them silently, so this would import as a waitlisted seat with no error. Public seats are EXTRA.',
      });
      allocationType = 'EXTRA';
    }

    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        key,
        rowNumbers: [],
        contactName,
        contactEmail,
        requestedAt,
        playerId: null,
        playerName: null,
        seats: [],
        blocked: false,
        /**
         * Built from the values rather than from `key`, because a party grouped
         * by a mapped `group_key` column still has a contact email and a
         * timestamp, and those are what the database stored. Keying dedup off
         * the grouping key instead would make a sheet that gained a group
         * column re-import everything it had already committed.
         */
        dedupKey: contactEmail ? `${contactEmail}|${requestedAt.toISOString()}` : null,
        skipped: false,
      };
      drafts.set(key, draft);
      order.push(key);
    } else if (draft.contactName !== contactName) {
      add({
        level: 'WARNING',
        code: 'PARTY_CONTACT_DISAGREEMENT',
        rowNumber: row.rowNumber,
        partyKey: key,
        message: `The other rows of this party give the contact name as "${draft.contactName}"; row ${row.rowNumber} says "${contactName}". The first row in file order wins.`,
      });
    }

    draft.rowNumbers.push(row.rowNumber);
    draft.seats.push({
      rowNumber: row.rowNumber,
      fullName: attendeeName,
      email: attendeeEmail,
      allocationType,
      promotedFromBase: false,
    });
    if (blockedHere) draft.blocked = true;
  }

  /**
   * §9.2: a party already in this segment is skipped rather than written again.
   *
   * Before player matching, because a re-imported party trips
   * PLAYER_ALREADY_REGISTERED against the very registration it *is*, and
   * blocking on that would refuse the whole run — including the new rows the
   * admin appended, which is the entire point of re-uploading the sheet.
   */
  for (const key of order) {
    const draft = drafts.get(key)!;
    if (draft.dedupKey == null) continue;
    const existing = context.existingParties.get(draft.dedupKey);
    if (!existing) continue;

    draft.skipped = true;
    if (existing.seats === draft.seats.length) {
      add({
        level: 'INFO',
        code: 'PARTY_ALREADY_IMPORTED',
        rowNumber: draft.rowNumbers[0],
        partyKey: key,
        message: `${draft.contactName} was imported into this segment already, with the same ${existing.seats} seat${existing.seats === 1 ? '' : 's'}. Skipped.`,
      });
    } else {
      /**
       * The sheet gained or lost a seat on a response that is already
       * committed. Still skipped: after commit this database is the source of
       * truth (§9.1), and the admin may have edited this very party since.
       */
      add({
        level: 'WARNING',
        code: 'PARTY_SIZE_CHANGED',
        rowNumber: draft.rowNumbers[0],
        partyKey: key,
        message: `${draft.contactName} was imported with ${existing.seats} seat${existing.seats === 1 ? '' : 's'}, but this file gives ${draft.seats.length}. Skipped - change the registration in the admin console (§7.6) rather than importing it twice.`,
      });
    }
  }

  // Player matching, per party, PLAYER_INVITED only.
  if (context.audienceMode === 'PLAYER_INVITED' && profile.playerMatch) {
    const matchColumn = profile.playerMatch.column;
    const byRow = new Map(rows.map((r) => [r.rowNumber, r]));
    for (const key of order) {
      const draft = drafts.get(key)!;
      const firstRow = byRow.get(draft.rowNumbers[0]);
      const raw = firstRow ? cell(firstRow, matchColumn, profile.transforms) : null;
      const match = raw == null ? null : (context.playerMatches.get(raw) ?? null);

      /**
       * An explicit choice from the dry-run screen outranks matching entirely.
       *
       * It is checked before `!match` rather than after, because the case that
       * most needs it is the one where nothing matched at all — a name the
       * roster spells differently, which no threshold can rescue.
       */
      const override = raw == null ? undefined : context.playerOverrides.get(raw);
      if (override) {
        draft.playerId = override.playerId;
        draft.playerName = override.fullName;
        add({
          level: 'INFO',
          code: 'PLAYER_MATCH_OVERRIDDEN',
          rowNumber: draft.rowNumbers[0],
          partyKey: key,
          message: `"${raw}" was set to ${override.fullName} by hand.`,
        });
      } else if (!match) {
        draft.blocked = true;
        add({
          level: 'BLOCKING',
          code: 'PLAYER_NOT_MATCHED',
          rowNumber: draft.rowNumbers[0],
          partyKey: key,
          message: raw
            ? `No player matches "${raw}". Choose one on this screen, add them on the players screen, or skip these rows - a player-invited seat with no player is owed no base allocation.`
            : `Row ${draft.rowNumbers[0]} has nothing in "${matchColumn}", so no player can be matched.`,
          ...(raw ? { match: { needle: raw } } : {}),
        });
        continue;
      } else {
        draft.playerId = match.playerId;
        draft.playerName = match.fullName;
        if (match.needsConfirmation) {
          draft.blocked = true;
          add({
            level: 'BLOCKING',
            code: 'PLAYER_MATCH_UNCONFIRMED',
            rowNumber: draft.rowNumbers[0],
            partyKey: key,
            message: `"${raw}" matched ${match.fullName} at ${(match.confidence * 100).toFixed(0)}% similarity, below the confirmation threshold. Confirm or correct it.`,
            match: {
              needle: raw!,
              playerId: match.playerId,
              playerName: match.fullName,
              confidence: match.confidence,
            },
          });
        }
      }
      // Reads the draft rather than `match`, so an overridden player is checked
      // against §7.6 exactly as a matched one is. Choosing a player by hand must
      // not be a way round the one-registration-per-player rule.
      if (
        draft.playerId != null &&
        !draft.skipped &&
        context.playersWithExistingRegistration.has(draft.playerId)
      ) {
        draft.blocked = true;
        add({
          level: 'BLOCKING',
          code: 'PLAYER_ALREADY_REGISTERED',
          rowNumber: draft.rowNumbers[0],
          partyKey: key,
          message: `${draft.playerName} already has a registration for this show. Skipped - edit the existing one instead (§7.6).`,
        });
      }
    }
  }

  // Parties are walked in requested_at order, because that is the order
  // claim_seats() will be called in and therefore the order the pool is spent
  // in (§7.4). Ties break on the first row number so the walk is deterministic.
  const parties: PlannedParty[] = order
    .map((k) => drafts.get(k)!)
    .sort(
      (a, b) =>
        a.requestedAt.getTime() - b.requestedAt.getTime() || a.rowNumbers[0] - b.rowNumbers[0],
    )
    .map((d) => ({
      key: d.key,
      rowNumbers: d.rowNumbers,
      contactName: d.contactName,
      contactEmail: d.contactEmail,
      requestedAt: d.requestedAt,
      playerId: d.playerId,
      playerName: d.playerName,
      seats: d.seats,
      blocked: d.blocked,
      dedupKey: d.dedupKey,
      skipped: d.skipped,
    }));

  // §9.5: the engine does not promote surplus base to extra — a BASE seat past
  // the quota waitlists. Import does it, counting per player across the whole
  // file and across what they already hold, exactly as claim_seats() counts it.
  const baseUsed = new Map<number, number>(context.baseAlreadyClaimed);
  let promotedToExtra = 0;
  for (const party of parties) {
    if (party.blocked || party.skipped || party.playerId == null || context.baseQuota == null) {
      continue;
    }
    for (const seat of party.seats) {
      if (seat.allocationType !== 'BASE') continue;
      const used = baseUsed.get(party.playerId) ?? 0;
      if (used < context.baseQuota) {
        baseUsed.set(party.playerId, used + 1);
      } else {
        seat.allocationType = 'EXTRA';
        seat.promotedFromBase = true;
        promotedToExtra += 1;
      }
    }
    const promoted = party.seats.filter((s) => s.promotedFromBase).length;
    if (promoted > 0) {
      add({
        level: 'INFO',
        code: 'BASE_SURPLUS_PROMOTED',
        rowNumber: party.rowNumbers[0],
        partyKey: party.key,
        message: `${promoted} of ${party.seats.length} seats exceed the base quota and will be requested as extras.`,
      });
    }
  }

  // Party size cap. A warning, never blocking: the cap governs the form, and an
  // admin may have granted more deliberately (§9.4).
  if (context.maxTicketsPerResponse != null) {
    for (const party of parties) {
      if (party.skipped) continue;
      if (party.seats.length > context.maxTicketsPerResponse) {
        add({
          level: 'WARNING',
          code: 'PARTY_OVER_CAP',
          rowNumber: party.rowNumbers[0],
          partyKey: party.key,
          message: `${party.seats.length} seats, above the ${context.maxTicketsPerResponse}-seat cap for this segment. Imported and flagged.`,
        });
      }
    }
  }

  const live = liveParties(parties);
  const seats = live.flatMap((p) => p.seats);
  const baseSeats = seats.filter((s) => s.allocationType === 'BASE').length;
  const extraSeats = seats.length - baseSeats;

  const predicted = predict(baseSeats, extraSeats, context);

  // Under REVIEW an extras request holds as PENDING_REVIEW and consumes no
  // seats (§7.4), so it cannot overflow anything at intake. Under AUTO_FCFS it
  // is granted immediately and does.
  const seatsConsumed = context.extrasPolicy === 'REVIEW' ? baseSeats : seats.length;
  const available =
    context.extrasPolicy === 'REVIEW'
      ? context.openSeats
      : Math.min(context.openSeats, baseSeats + context.extrasPool);
  if (seatsConsumed > available) {
    add({
      level: 'BLOCKING',
      code: 'CAPACITY_EXCEEDED',
      message: `This import needs ${seatsConsumed} seats but only ${available} can be granted (${context.openSeats} open, extras pool ${context.extrasPool}). Cap the file in row order, or raise the capacity of the segment - ${seatsConsumed - available} seats over.`,
    });
  }

  // A file that fits capacity can still waitlist, because BASE is bounded by
  // each player's quota and EXTRA by the pool. Saying so before the commit is
  // the difference between a preview and a guess (§9.6).
  if (predicted.waitlisted > 0) {
    add({
      level: 'WARNING',
      code: 'SEATS_WILL_WAITLIST',
      message: `${predicted.waitlisted} of ${seats.length} seats will be waitlisted rather than confirmed - the pool does not hold them.`,
    });
  }

  const level = (l: FindingLevel) => findings.filter((f) => f.level === l).length;

  return {
    parties,
    findings,
    counts: {
      rows: rows.length,
      parties: parties.length,
      seats: seats.length,
      baseSeats,
      extraSeats,
      promotedToExtra,
      placeholderNames: seats.filter((s) => s.fullName == null).length,
      predictedConfirmed: predicted.confirmed,
      predictedPending: predicted.pending,
      predictedWaitlisted: predicted.waitlisted,
      ungrouped,
      skippedParties: parties.filter((p) => p.skipped).length,
      blocking: level('BLOCKING'),
      warning: level('WARNING'),
      info: level('INFO'),
    },
    largestParty: parties.reduce((m, p) => Math.max(m, p.seats.length), 0),
  };
}

/**
 * What `claim_seats()` is expected to do with these seats.
 *
 * A prediction, not a promise — the engine decides, and it decides against the
 * pool as it stands at commit rather than at preview. It mirrors the engine's
 * own two-pass shape (§7.8): entitlement seats are decided first and spend the
 * segment's room, then the extras budget is sized against what is genuinely
 * left. Without it the dry run can report a clean file that arrives entirely
 * waitlisted under a success banner, which is exactly the silent failure the dry
 * run exists to prevent.
 */
function predict(
  baseSeats: number,
  extraSeats: number,
  context: PlanContext,
): { confirmed: number; pending: number; waitlisted: number } {
  const baseGranted = Math.min(baseSeats, Math.max(0, context.openSeats));
  const baseWaitlisted = baseSeats - baseGranted;

  if (context.extrasPolicy === 'REVIEW') {
    // Extras hold as PENDING_REVIEW consuming nothing; the admin grants later.
    return { confirmed: baseGranted, pending: extraSeats, waitlisted: baseWaitlisted };
  }

  const roomLeft = Math.max(0, context.openSeats - baseGranted);
  const extraGranted = Math.min(extraSeats, Math.max(0, context.extrasPool), roomLeft);
  return {
    confirmed: baseGranted + extraGranted,
    pending: 0,
    waitlisted: baseWaitlisted + (extraSeats - extraGranted),
  };
}
