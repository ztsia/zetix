import 'server-only';
import { detectHeaderRow, parseWorkbook, toSheetRows } from '@/lib/import/parse';

/**
 * Reading a player list out of a spreadsheet (spec/admin.md §14.1 — "players:
 * CRUD, CSV import").
 *
 * **This reuses module `C`'s parser rather than adding a second one.**
 * `parseWorkbook` already reads both `.csv` and `.xlsx`, is already a
 * dependency, and is already the thing that decides what row 14 says — two
 * parsers of one file are two chances to disagree about that.
 *
 * What it deliberately does *not* reuse is `C`'s mapping and grouping machinery.
 * That exists to rebuild registrations-as-parties from a long sheet
 * (decision 33); a player list is one person per row with no parties, no
 * `requested_at` and no seats, so borrowing it would mean configuring a
 * grouping step that has nothing to group.
 */

export type PlayerField = 'fullName' | 'email' | 'instrument' | 'section';

/**
 * Header spellings that map to each field.
 *
 * A preselection, not a rule — the import screen shows the mapping it chose and
 * lets the admin change it, because a header this list has never seen should be
 * visible rather than silently dropped.
 */
const HEADER_ALIASES: Record<PlayerField, readonly string[]> = {
  fullName: ['full name', 'name', 'player', 'player name', 'fullname'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  instrument: ['instrument', 'instrument played', 'part'],
  section: ['section', 'desk', 'group', 'family'],
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/** The best guess at which column holds which field. */
export function guessMapping(headers: readonly string[]): Record<PlayerField, string | null> {
  const used = new Set<string>();
  const mapping = {} as Record<PlayerField, string | null>;

  // Exact alias matches first, across all fields, so a sheet with both "Name"
  // and "Section name" does not let the loop order decide which wins.
  for (const pass of ['exact', 'partial'] as const) {
    for (const field of Object.keys(HEADER_ALIASES) as PlayerField[]) {
      if (mapping[field]) continue;
      const aliases = HEADER_ALIASES[field];
      const found = headers.find((header) => {
        if (used.has(header)) return false;
        const h = normalise(header);
        return pass === 'exact'
          ? aliases.includes(h)
          : aliases.some((alias) => h.includes(alias));
      });
      if (found) {
        mapping[field] = found;
        used.add(found);
      }
    }
  }

  for (const field of Object.keys(HEADER_ALIASES) as PlayerField[]) {
    mapping[field] ??= null;
  }
  return mapping;
}

export type PlannedPlayer = {
  /** The spreadsheet line, so a finding names the number the admin sees. */
  rowNumber: number;
  fullName: string;
  email: string | null;
  instrument: string | null;
  section: string | null;
  /**
   * `create` — new. `update` — an active player with this email already exists,
   * and the other columns are refreshed. `skip` — unusable, with a reason.
   */
  action: 'create' | 'update' | 'skip';
  reason?: string;
};

export type PlayerImportPlan = {
  headers: string[];
  mapping: Record<PlayerField, string | null>;
  rows: PlannedPlayer[];
  counts: { create: number; update: number; skip: number };
};

export type ExistingPlayer = { id: number; email: string | null };

/**
 * Reads the file and decides what each row would do.
 *
 * Nothing is written here. The screen shows this, the admin reads it, and the
 * commit re-parses the same file rather than trusting a plan that has been
 * through the browser.
 */
export async function planPlayerImport(
  bytes: Buffer,
  filename: string,
  existing: readonly ExistingPlayer[],
  overrides?: Partial<Record<PlayerField, string | null>>,
): Promise<PlayerImportPlan> {
  const workbook = await parseWorkbook(bytes, filename);
  const sheet = workbook.sheets[0];
  const { headers, rows } = toSheetRows(sheet, detectHeaderRow(sheet.rows));

  const mapping = { ...guessMapping(headers), ...overrides };

  const byEmail = new Map<string, number>();
  for (const player of existing) {
    if (player.email) byEmail.set(player.email.toLowerCase(), player.id);
  }

  // Within one file too: two rows sharing an address are one player, and the
  // second would otherwise fail on the unique index halfway through the commit.
  const seenInFile = new Set<string>();
  const planned: PlannedPlayer[] = [];

  for (const row of rows) {
    const value = (field: PlayerField): string | null => {
      const column = mapping[field];
      if (!column) return null;
      const text = (row.cells[column] ?? '').trim();
      return text === '' ? null : text;
    };

    const fullName = value('fullName');
    const email = value('email');
    const base = {
      rowNumber: row.rowNumber,
      fullName: fullName ?? '',
      email: email ? email.toLowerCase() : null,
      instrument: value('instrument'),
      section: value('section'),
    };

    if (!fullName) {
      // A player with no name cannot be told apart from another on any screen.
      // This is not the placeholder case of decision 32 — that is about a
      // *guest* on someone else's registration, who still holds a real ticket.
      planned.push({ ...base, action: 'skip', reason: 'No name in this row.' });
      continue;
    }

    if (email && !email.includes('@')) {
      planned.push({ ...base, action: 'skip', reason: `“${email}” is not an email address.` });
      continue;
    }

    if (base.email && seenInFile.has(base.email)) {
      planned.push({
        ...base,
        action: 'skip',
        reason: 'This address appears earlier in the file.',
      });
      continue;
    }
    if (base.email) seenInFile.add(base.email);

    planned.push({
      ...base,
      action: base.email && byEmail.has(base.email) ? 'update' : 'create',
    });
  }

  return {
    headers,
    mapping,
    rows: planned,
    counts: {
      create: planned.filter((r) => r.action === 'create').length,
      update: planned.filter((r) => r.action === 'update').length,
      skip: planned.filter((r) => r.action === 'skip').length,
    },
  };
}
