import type { AllocationChoice, MappingProfile } from './profile';

/**
 * Shared shapes and cell readers for spreadsheet import.
 *
 * V1's dry-run planner lived here and was retired with V3's staging grid
 * (spec/v3.md §25.7, decision 49): rows are now validated where they are
 * edited (`staging.ts`) and committed a party at a time
 * (`staging-commands.ts`). What remains is what both read a sheet with.
 */

export type PlayerMatch =
  | { playerId: number; fullName: string; confidence: number; needsConfirmation: boolean }
  | null;

/** A parsed sheet row: header to cell text, plus the row's 1-based sheet line. */
export type SheetRow = { rowNumber: number; cells: Record<string, string> };

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

