import type { Finding, ImportPlan } from '@/lib/import/plan';
import type { SuggestedColumns } from '@/lib/import/template';

/**
 * The wire shapes between the import screen and `/api/import`.
 *
 * Declared once and shared by both sides, so a field the route stops sending is
 * a type error on the screen rather than an `undefined` in a table cell.
 */

/** One active player of this concert, for the dry run's match picker (§9.3). */
export type RosterPlayer = { id: number; fullName: string };

export type InspectResponse = {
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  sheets: { name: string; rowCount: number; detectedHeaderRow: number }[];
  sheet: string;
  headerRow: number;
  headers: string[];
  rowCount: number;
  sample: Record<string, string>[];
  suggested: SuggestedColumns;
  allocationValues: string[];
  preview: { header: string; distinct: number }[];
};

export type PlanResponse = {
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  counts: ImportPlan['counts'];
  largestParty: number;
  findings: Finding[];
  openSeats: number;
  extrasPool: number;
  extrasPolicy: 'REVIEW' | 'AUTO_FCFS';
  parties: {
    key: string;
    rows: number[];
    contactName: string;
    contactEmail: string | null;
    requestedAt: string;
    playerId: number | null;
    playerName: string | null;
    blocked: boolean;
    seats: {
      rowNumber: number;
      fullName: string | null;
      email: string | null;
      allocationType: 'BASE' | 'EXTRA';
      promotedFromBase: boolean;
    }[];
  }[];
  batchId?: number;
  committed?: boolean;
  outcome?: {
    batchId: number;
    createdRegistrations: number;
    createdAttendees: number;
    skippedParties: number;
    granted: { base: number; extra: number; pending: number; waitlisted: number };
  };
};
