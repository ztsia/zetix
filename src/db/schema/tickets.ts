import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { backgroundKind } from './enums';
import { concerts } from './concerts';
import { fk, pk, timestamps } from './columns';

/**
 * `ticket_templates` — a canvas layout over a background asset
 * (spec/domain.md §5.1, spec/tickets.md §10.2).
 *
 * **Each row is one version, and a version becomes immutable the moment a
 * ticket is issued against it.** `attendees` pin `(ticket_template_id,
 * ticket_template_version)` at issue time and rendering always uses the pinned
 * pair (spec/tickets.md §10.5), so rewriting a pinned row would make the PDF in
 * someone's inbox and the PDF behind their portal link silently disagree.
 *
 * A version **nothing is pinned to** is edited in place instead: there is no
 * copy anywhere to disagree with, and minting a version per nudged text box
 * would make the number meaningless. `saveTemplate()` is where that condition
 * lives. This comment used to say every row was immutable outright, which module
 * `E` made untrue.
 *
 * `concert_id` null means a global default — the seeded template that lets the
 * system render a ticket before anyone opens the editor (decision 10).
 */
export const ticketTemplates = pgTable(
  'ticket_templates',
  {
    id: pk(),
    concertId: fk('concert_id').references(() => concerts.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    version: integer('version').notNull(),

    /**
     * The previous version this one was edited from. Null starts a lineage.
     *
     * The one column here that spec/domain.md §5.1 does not name. With each row
     * being a version, nothing else links a template's versions to each other,
     * and the editor (module E) needs that to show a history. One nullable
     * self-reference now costs less than a second migration against a frozen
     * schema (spec/modules.md §4).
     */
    supersedesId: fk('supersedes_id').references((): AnyPgColumn => ticketTemplates.id, {
      onDelete: 'set null',
    }),

    backgroundAssetPath: text('background_asset_path'),
    backgroundKind: backgroundKind('background_kind').notNull(),

    /** Points, not pixels — the render target is a PDF (spec/tickets.md §10.2). */
    pageWidthPt: integer('page_width_pt').notNull(),
    pageHeightPt: integer('page_height_pt').notNull(),

    layout: jsonb('layout').notNull(),
    isDefault: boolean('is_default').notNull().default(false),

    ...timestamps,
  },
  (t) => [uniqueIndex('ticket_templates_name_version_key').on(t.concertId, t.name, t.version)],
);
