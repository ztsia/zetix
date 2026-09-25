/**
 * The Activity log's row shapes (spec/v3.md §23.1, §23.6), shared by the
 * server queries and the page's client components.
 */

export type ActivityRow = {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  commandRunId: number | null;
  before: unknown;
  after: unknown;
};

export type RunRow = {
  id: number;
  command: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  actor: string | null;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type Paged<T> = { rows: T[]; total: number };

/**
 * The entity types offered as built-in views. Both spellings the code writes
 * are grouped under one view (`audit_log_concert_of()` in `0201` lists them).
 */
export const ACTIVITY_VIEWS = [
  { id: 'parties', label: 'Parties', types: ['registration'] },
  { id: 'seats', label: 'Seats', types: ['attendee', 'check_ins'] },
  { id: 'messages', label: 'Messages', types: ['email_outbox'] },
  { id: 'setup', label: 'Setup', types: ['concert', 'concerts', 'show', 'shows', 'show_segment', 'registration_form', 'ticket_template', 'booklets'] },
  { id: 'players', label: 'Players', types: ['player', 'players', 'portal_notes'] },
  { id: 'imports', label: 'Imports', types: ['import_batch'] },
] as const;

export type ActivityViewId = (typeof ACTIVITY_VIEWS)[number]['id'];
