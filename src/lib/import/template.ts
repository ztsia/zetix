/**
 * The normalized-sheet template (spec/import.md §9.6, step 1).
 *
 * **Constants and pure functions only — no `exceljs`.** Step 1 renders the
 * before-and-after example from these, so this module reaches the client; the
 * writers that turn them into a downloadable file live in `template-file.ts`,
 * which is server-only. Importing a spreadsheet writer into the admin bundle to
 * render a four-row example table is the sort of thing nobody notices until the
 * bundle is a megabyte.
 *
 * Decision 33 moved the wide-to-long reshaping onto the admin, which is only a
 * simplification if the screen explains it. This is the strongest half of that
 * explanation: an admin who fills this in gets a sheet whose columns map
 * themselves, so the mapping step becomes a confirmation rather than a task.
 *
 * The headers here are the ones {@link defaultProfileFor} maps by name, so the
 * two must change together — which is why they are one module.
 */

export const TEMPLATE_HEADERS = {
  timestamp: 'Timestamp',
  contactName: 'Contact Name',
  contactEmail: 'Contact Email',
  attendeeName: 'Attendee Name',
  attendeeEmail: 'Attendee Email',
  ticketType: 'Ticket Type',
} as const;

type Row = Record<string, string>;

/**
 * Two worked parties, deliberately.
 *
 * The example rows are the second half of the explanation: a party of three and
 * a party of one, with the contact columns **repeated on every row**, because
 * that repetition is the §9.2 grouping key and the one thing a careful admin
 * would otherwise tidy away by filling the contact columns on the first row of
 * each party only. Showing it is more reliable than saying it.
 */
export const TEMPLATE_EXAMPLE_ROWS: Row[] = [
  {
    [TEMPLATE_HEADERS.timestamp]: '2026-09-01 09:14:22',
    [TEMPLATE_HEADERS.contactName]: 'Alice Tan',
    [TEMPLATE_HEADERS.contactEmail]: 'alice@example.com',
    [TEMPLATE_HEADERS.attendeeName]: 'Alice Tan',
    [TEMPLATE_HEADERS.attendeeEmail]: 'alice@example.com',
    [TEMPLATE_HEADERS.ticketType]: 'Allocated',
  },
  {
    [TEMPLATE_HEADERS.timestamp]: '2026-09-01 09:14:22',
    [TEMPLATE_HEADERS.contactName]: 'Alice Tan',
    [TEMPLATE_HEADERS.contactEmail]: 'alice@example.com',
    [TEMPLATE_HEADERS.attendeeName]: 'Ben Tan',
    [TEMPLATE_HEADERS.attendeeEmail]: '',
    [TEMPLATE_HEADERS.ticketType]: 'Allocated',
  },
  {
    [TEMPLATE_HEADERS.timestamp]: '2026-09-01 09:14:22',
    [TEMPLATE_HEADERS.contactName]: 'Alice Tan',
    [TEMPLATE_HEADERS.contactEmail]: 'alice@example.com',
    // Left blank on purpose: an unnamed seat is not an error, it tickets as
    // "Guest of Alice Tan" (decision 32). The template says so by example.
    [TEMPLATE_HEADERS.attendeeName]: '',
    [TEMPLATE_HEADERS.attendeeEmail]: '',
    [TEMPLATE_HEADERS.ticketType]: 'Extra',
  },
  {
    [TEMPLATE_HEADERS.timestamp]: '2026-09-01 11:02:47',
    [TEMPLATE_HEADERS.contactName]: 'Carol Lim',
    [TEMPLATE_HEADERS.contactEmail]: 'carol@example.com',
    [TEMPLATE_HEADERS.attendeeName]: 'Carol Lim',
    [TEMPLATE_HEADERS.attendeeEmail]: 'carol@example.com',
    [TEMPLATE_HEADERS.ticketType]: 'Allocated',
  },
];

/**
 * The wide shape the admin is reshaping *from*, for the before-and-after in
 * step 1. Same two parties as above, so the reshaping is legible rather than
 * merely described.
 */
export const TEMPLATE_WIDE_EXAMPLE = {
  headers: [
    'Timestamp',
    'Email Address',
    'Your name',
    'Guest 1 Name',
    'Guest 2 Name',
    'Extra Ticket 1 Name',
  ],
  rows: [
    ['2026-09-01 09:14:22', 'alice@example.com', 'Alice Tan', 'Ben Tan', '', ''],
    ['2026-09-01 11:02:47', 'carol@example.com', 'Carol Lim', '', '', ''],
  ],
};

/**
 * The mapping profile a file built from this template needs, with nothing left
 * to choose but the allocation values.
 *
 * `defaultAllocationType` is the caller's, because it is the one thing the
 * template cannot know: a public segment's seats are always `EXTRA` (§9.5), and
 * a player segment's depend on what the form asked.
 */
export function defaultProfileFor(defaultAllocationType: 'BASE' | 'EXTRA') {
  return {
    header_row: 1,
    columns: {
      requested_at: TEMPLATE_HEADERS.timestamp,
      contact_name: TEMPLATE_HEADERS.contactName,
      contact_email: TEMPLATE_HEADERS.contactEmail,
      attendee_name: TEMPLATE_HEADERS.attendeeName,
      attendee_email: TEMPLATE_HEADERS.attendeeEmail,
      allocation_type: TEMPLATE_HEADERS.ticketType,
      group_key: null,
    },
    allocation_type_values: {
      BASE: ['Allocated', 'Base', 'Invited'],
      EXTRA: ['Extra', 'Additional', 'Guest'],
    },
    default_allocation_type: defaultAllocationType,
  };
}

export type SuggestedColumns = {
  requested_at: string | null;
  contact_name: string | null;
  contact_email: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  allocation_type: string | null;
  group_key: string | null;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Candidate header names per target, most specific first.
 *
 * Order across targets matters as much as order within one: `attendee_email` is
 * resolved before `contact_email` so that a sheet carrying both does not let the
 * looser "Email" candidate claim the attendee column first.
 */
const CANDIDATES: [keyof SuggestedColumns, string[]][] = [
  ['requested_at', ['Timestamp', 'Submitted at', 'Response time', 'Date']],
  ['attendee_email', ['Attendee Email', 'Guest Email']],
  ['attendee_name', ['Attendee Name', 'Guest Name']],
  ['contact_email', ['Contact Email', 'Email Address', 'Email']],
  ['contact_name', ['Contact Name', 'Your name', 'Full name', 'Name']],
  ['allocation_type', ['Ticket Type', 'Allocation Type', 'Allocation', 'Type']],
  ['group_key', ['Group Key', 'Group', 'Party']],
];

/**
 * Suggests a mapping by matching the file's own headers against the template's.
 *
 * A suggestion, never an application: §9.2 keeps auto-detection advisory and the
 * screen shows every proposal for confirmation. A file straight from the
 * template matches everything and the admin only confirms; a hand-made file
 * matches some and the admin fills in the rest.
 *
 * Two rules keep it from being confidently wrong, which is worse than being
 * blank. **Every exact match is claimed before any fuzzy one**, so a sheet with
 * both "Contact Email" and "Attendee Email" cannot have the looser candidate
 * take the wrong column. And **a header is used once**: without that, the
 * "Name" candidate for `contact_name` happily matches "Attendee Name" by
 * containment and maps two targets onto one column.
 */
export function suggestColumns(headers: readonly string[]): SuggestedColumns {
  const out: SuggestedColumns = {
    requested_at: null,
    contact_name: null,
    contact_email: null,
    attendee_name: null,
    attendee_email: null,
    allocation_type: null,
    group_key: null,
  };

  const taken = new Set<string>();
  const available = () => headers.filter((h) => !taken.has(h));

  // Pass 1: exact, normalised equality.
  for (const [target, candidates] of CANDIDATES) {
    for (const candidate of candidates) {
      const hit = available().find((h) => norm(h) === norm(candidate));
      if (hit) {
        out[target] = hit;
        taken.add(hit);
        break;
      }
    }
  }

  // Pass 2: containment, for headers like "Timestamp (GMT+8)". Only for targets
  // still unresolved, and only over headers no exact match has claimed.
  for (const [target, candidates] of CANDIDATES) {
    if (out[target]) continue;
    for (const candidate of candidates) {
      const n = norm(candidate);
      const hit = available().find((h) => norm(h).includes(n));
      if (hit) {
        out[target] = hit;
        taken.add(hit);
        break;
      }
    }
  }

  return out;
}
