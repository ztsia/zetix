import { z } from 'zod';

/**
 * The Trash's kinds, labels and row shapes (spec/v3.md §23.6) — the parts the
 * page's client components need, kept apart from the server-only queries.
 */

export const TRASH_KINDS = ['party', 'seat', 'message', 'form', 'player', 'ticket_template'] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export const trashKindSchema = z.enum(TRASH_KINDS);

export const KIND_LABEL: Record<TrashKind, { one: string; many: string; title: string }> = {
  party: { one: 'party', many: 'parties', title: 'Parties' },
  seat: { one: 'seat', many: 'seats', title: 'Seats' },
  message: { one: 'message', many: 'messages', title: 'Messages' },
  form: { one: 'form', many: 'forms', title: 'Forms' },
  player: { one: 'player', many: 'players', title: 'Players' },
  ticket_template: { one: 'ticket design', many: 'ticket designs', title: 'Ticket designs' },
};

/** The `entity_type` each kind is audited and targeted under, as the code already writes it. */
export const KIND_ENTITY: Record<TrashKind, string> = {
  party: 'registration',
  seat: 'attendee',
  message: 'email_outbox',
  form: 'registration_form',
  player: 'player',
  ticket_template: 'ticket_template',
};

/** The filter a "select all matching" in the Trash sends. */
export const trashFilterSchema = z.object({ search: z.string().max(200) }).strict();
export type TrashFilter = z.infer<typeof trashFilterSchema>;

export type TrashRow = { id: number; label: string; detail: string | null; deletedAt: string };

export type TrashPage = {
  rows: TrashRow[];
  total: number;
  counts: Record<TrashKind, number>;
};

