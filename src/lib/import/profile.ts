import { z } from 'zod';

/**
 * The mapping profile — the stored contract between a spreadsheet and this
 * system (spec/import.md §9.3), persisted in `mapping_profiles.config`.
 *
 * The stored JSON is snake_case exactly as §9.3 writes it, and the parsed value
 * is camelCase like the rest of the codebase. The translation lives here, in one
 * schema, rather than in every reader: a profile saved by a previous round has
 * to keep parsing after a refactor, so the shape on disk is a contract and the
 * shape in memory is an implementation detail.
 */

/**
 * Import only ever assigns `BASE` or `EXTRA`.
 *
 * `allocation_type` also has `HELD` and `COMP`, and they are deliberately not
 * here (spec/import.md §9.6). Both are per-seat decisions a person makes — a
 * seat withheld, a seat comped — and an importer that offered them invites a
 * whole file to arrive as `COMP`, outside the §7.2 pool arithmetic, with nobody
 * having decided any of those seats individually.
 */
export const ALLOCATION_CHOICES = ['BASE', 'EXTRA'] as const;
export type AllocationChoice = (typeof ALLOCATION_CHOICES)[number];

export const PLAYER_MATCH_STRATEGIES = ['EMAIL', 'NAME', 'NAME_FUZZY'] as const;
export type PlayerMatchStrategy = (typeof PLAYER_MATCH_STRATEGIES)[number];

/** A header name in the uploaded sheet, or null for "not mapped". */
const column = z.string().min(1).nullable().optional().default(null);

const configSchema = z
  .object({
    sheet: z.string().min(1).nullable().optional().default(null),
    /** 1-based, as a spreadsheet numbers its rows. */
    header_row: z.number().int().positive().default(1),

    columns: z
      .object({
        /**
         * Optional since V3 (spec/v3.md §25.7): without it, file order is the
         * first-come order. It matters only for extras.
         */
        requested_at: column,
        contact_name: z.string().min(1),
        contact_email: column,
        attendee_name: column,
        attendee_email: column,
        allocation_type: column,
        /** Overrides the §9.2 grouping rule outright when mapped. */
        group_key: column,
      })
      .strict(),

    /**
     * A wide sheet's repeating guest columns (spec/v3.md §25.7, decision 49):
     * each group is one seat per line, and a line with any of the group's
     * cells filled becomes a row of its own in the staging grid.
     */
    seat_groups: z
      .array(
        z
          .object({
            attendee_name: z.string().min(1),
            attendee_email: column,
            /** A fixed type for the group; null uses the type column or the default. */
            allocation_type: z.enum(['BASE', 'EXTRA']).nullable().optional().default(null),
          })
          .strict(),
      )
      .default([]),
    /** The contact is a seat of the party too, as on a public form (decision 36). */
    registrant_seat: z.boolean().default(false),

    player_match: z
      .object({
        column: z.string().min(1),
        strategy: z.enum(PLAYER_MATCH_STRATEGIES),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),

    /**
     * Sheet text → allocation type, matched case-insensitively after trimming.
     * The screen builds this from the distinct values actually present in the
     * chosen column (§9.6), so a value that maps to nothing is visible rather
     * than guessed at.
     */
    allocation_type_values: z
      .object({
        BASE: z.array(z.string()).default([]),
        EXTRA: z.array(z.string()).default([]),
      })
      .strict()
      .default({ BASE: [], EXTRA: [] }),

    /** Used for every row when `columns.allocation_type` is unmapped (§9.5). */
    default_allocation_type: z.enum(ALLOCATION_CHOICES),

    transforms: z
      .object({
        trim_whitespace: z.boolean().default(true),
        lowercase_emails: z.boolean().default(true),
        titlecase_names: z.boolean().default(false),
      })
      .strict()
      .default({ trim_whitespace: true, lowercase_emails: true, titlecase_names: false }),
  })
  .strict();

export type StoredMappingProfile = z.input<typeof configSchema>;

export type MappingProfile = {
  sheet: string | null;
  headerRow: number;
  columns: {
    requestedAt: string | null;
    contactName: string;
    contactEmail: string | null;
    attendeeName: string | null;
    attendeeEmail: string | null;
    allocationType: string | null;
    groupKey: string | null;
  };
  seatGroups: { attendeeName: string; attendeeEmail: string | null; allocationType: AllocationChoice | null }[];
  registrantSeat: boolean;
  playerMatch: { column: string; strategy: PlayerMatchStrategy } | null;
  allocationTypeValues: Record<AllocationChoice, string[]>;
  defaultAllocationType: AllocationChoice;
  transforms: {
    trimWhitespace: boolean;
    lowercaseEmails: boolean;
    titlecaseNames: boolean;
  };
};

/** Parses stored JSON into the in-memory shape. Throws on a malformed profile. */
export function parseMappingProfile(input: unknown): MappingProfile {
  const c = configSchema.parse(input);
  return {
    sheet: c.sheet,
    headerRow: c.header_row,
    columns: {
      requestedAt: c.columns.requested_at,
      contactName: c.columns.contact_name,
      contactEmail: c.columns.contact_email,
      attendeeName: c.columns.attendee_name,
      attendeeEmail: c.columns.attendee_email,
      allocationType: c.columns.allocation_type,
      groupKey: c.columns.group_key,
    },
    seatGroups: c.seat_groups.map((g) => ({
      attendeeName: g.attendee_name,
      attendeeEmail: g.attendee_email,
      allocationType: g.allocation_type,
    })),
    registrantSeat: c.registrant_seat,
    playerMatch: c.player_match,
    allocationTypeValues: c.allocation_type_values,
    defaultAllocationType: c.default_allocation_type,
    transforms: {
      trimWhitespace: c.transforms.trim_whitespace,
      lowercaseEmails: c.transforms.lowercase_emails,
      titlecaseNames: c.transforms.titlecase_names,
    },
  };
}

/** The inverse, for writing a profile back to `mapping_profiles.config`. */
export function serialiseMappingProfile(p: MappingProfile): StoredMappingProfile {
  return {
    sheet: p.sheet,
    header_row: p.headerRow,
    columns: {
      requested_at: p.columns.requestedAt,
      contact_name: p.columns.contactName,
      contact_email: p.columns.contactEmail,
      attendee_name: p.columns.attendeeName,
      attendee_email: p.columns.attendeeEmail,
      allocation_type: p.columns.allocationType,
      group_key: p.columns.groupKey,
    },
    seat_groups: p.seatGroups.map((g) => ({
      attendee_name: g.attendeeName,
      attendee_email: g.attendeeEmail,
      allocation_type: g.allocationType,
    })),
    registrant_seat: p.registrantSeat,
    player_match: p.playerMatch,
    allocation_type_values: p.allocationTypeValues,
    default_allocation_type: p.defaultAllocationType,
    transforms: {
      trim_whitespace: p.transforms.trimWhitespace,
      lowercase_emails: p.transforms.lowercaseEmails,
      titlecase_names: p.transforms.titlecaseNames,
    },
  };
}
