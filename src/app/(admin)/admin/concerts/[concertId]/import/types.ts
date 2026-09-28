import type { SuggestedColumns } from '@/lib/import/template';

/**
 * The wire shapes between the import screen and `/api/import`.
 *
 * Declared once and shared by both sides, so a field the route stops sending is
 * a type error on the screen rather than an `undefined` in a table cell.
 */

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
