import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `email_templates` — the eight message types of spec/email.md §11.3, as
 * Markdown with `{{ }}` placeholders.
 *
 * §11.3 requires these "stored in the DB, editable with live preview and a
 * documented token list"; spec/domain.md §5.1 never listed the table, so `F1`
 * built none. This is the small schema-only PR spec/modules.md §4 prescribes
 * for exactly that case, rather than a competing migration on module `F`'s
 * branch.
 *
 * **`key` is the primary key, and the table is not concert-scoped.** Two
 * reasons, both learned from `ticket_templates`:
 *
 * 1. A nullable `concert_id` meaning "global default" does not constrain
 *    anything — two NULLs never conflict in a Postgres unique index, so
 *    `(concert_id, key)` would let re-seeding silently duplicate every global
 *    row. Module `D` shipped that bug and had to correct it.
 * 2. Concert-to-concert variation is what the merge fields are *for*: one
 *    "Your tickets for {{ concert.name }}" serves every concert. Wording that
 *    genuinely had to differ per concert would be an additive override later,
 *    not a reshape of this table.
 *
 * **There is deliberately no version column, unlike `ticket_templates`.** A
 * ticket is pinned at issue time because the PDF someone already holds must not
 * change under them (spec/tickets.md §10.5). The equivalent guarantee for email
 * is already provided one layer down: `email_outbox.subject` and `body_md` hold
 * the *rendered* message, so a template edit cannot reach a row a human has
 * reviewed (decision 23, §11.5). Versioning here would pin nothing that is not
 * already pinned.
 */
export const emailTemplates = pgTable('email_templates', {
  /** One of the eight §11.3 keys: `player_confirmation`, `public_ticket`, … */
  key: text('key').primaryKey(),

  /** Shown in the admin list; the key itself is not a label. */
  name: text('name').notNull(),

  /**
   * Both carry `{{ }}` placeholders and are rendered per recipient into
   * `email_outbox` (§11.5). The plain-text alternative is generated from
   * `body_md` at render time rather than stored, so the two cannot drift.
   */
  subject: text('subject').notNull(),
  bodyMd: text('body_md').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});
