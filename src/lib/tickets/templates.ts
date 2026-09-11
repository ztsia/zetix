import 'server-only';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { attendees } from '@/db/schema/registrations';
import { ticketTemplates } from '@/db/schema/tickets';
import { contentTypeOf, type AssetKind } from './assets';
import { parseLayout, type Layout } from './layout';

/**
 * Reading and writing `ticket_templates` for the editor (spec/tickets.md §10.3).
 *
 * **The whole of §10.5 lives in `saveTemplate()`.** Everything else here is a
 * query. A template edit must never change a ticket somebody already holds, and
 * the mechanism that guarantees it is that attendees pin `(ticket_template_id,
 * ticket_template_version)` at issue time and the renderer only ever loads the
 * pinned pair.
 */

export type TemplateSummary = {
  id: number;
  name: string;
  version: number;
  isDefault: boolean;
  backgroundKind: 'IMAGE' | 'PDF' | 'NONE';
  backgroundAssetPath: string | null;
  pageWidthPt: number;
  pageHeightPt: number;
  elementCount: number;
  /** Attendees pinned to this exact version — the reason a save may clone. */
  issuedCount: number;
  updatedAt: string;
};

export type TemplateDetail = TemplateSummary & { layout: Layout };

/** Every template in a concert, newest version of each lineage first. */
export async function listTemplates(concertId: number): Promise<TemplateSummary[]> {
  const rows = await getDb().execute<{
    id: string;
    name: string;
    version: number;
    is_default: boolean;
    background_kind: 'IMAGE' | 'PDF' | 'NONE';
    background_asset_path: string | null;
    page_width_pt: number;
    page_height_pt: number;
    layout: unknown;
    issued_count: string;
    updated_at: string;
  }>(sql`
    select t.id, t.name, t.version, t.is_default, t.background_kind,
           t.background_asset_path, t.page_width_pt, t.page_height_pt, t.layout,
           t.updated_at,
           (select count(*) from attendees a
             where a.ticket_template_id = t.id
               and a.ticket_template_version = t.version) as issued_count
      from ticket_templates t
     where t.concert_id = ${concertId}
       and t.deleted_at is null
     order by t.name asc, t.version desc
  `);
  return rows.map(toSummary);
}

/** One template, or null when it does not exist or belongs to another concert. */
export async function loadTemplate(
  concertId: number,
  templateId: number,
): Promise<TemplateDetail | null> {
  const rows = await getDb().execute<{
    id: string;
    name: string;
    version: number;
    is_default: boolean;
    background_kind: 'IMAGE' | 'PDF' | 'NONE';
    background_asset_path: string | null;
    page_width_pt: number;
    page_height_pt: number;
    layout: unknown;
    issued_count: string;
    updated_at: string;
  }>(sql`
    select t.id, t.name, t.version, t.is_default, t.background_kind,
           t.background_asset_path, t.page_width_pt, t.page_height_pt, t.layout,
           t.updated_at,
           (select count(*) from attendees a
             where a.ticket_template_id = t.id
               and a.ticket_template_version = t.version) as issued_count
      from ticket_templates t
     where t.id = ${templateId}
       and t.concert_id = ${concertId}
       and t.deleted_at is null
     limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  return { ...toSummary(row), layout: parseLayout(row.layout) };
}

function toSummary(row: {
  id: string;
  name: string;
  version: number;
  is_default: boolean;
  background_kind: 'IMAGE' | 'PDF' | 'NONE';
  background_asset_path: string | null;
  page_width_pt: number;
  page_height_pt: number;
  layout: unknown;
  issued_count: string;
  updated_at: string;
}): TemplateSummary {
  const elements = (row.layout as { elements?: unknown[] } | null)?.elements;
  return {
    id: Number(row.id),
    name: row.name,
    version: row.version,
    isDefault: row.is_default,
    backgroundKind: row.background_kind,
    backgroundAssetPath: row.background_asset_path,
    pageWidthPt: row.page_width_pt,
    pageHeightPt: row.page_height_pt,
    elementCount: Array.isArray(elements) ? elements.length : 0,
    issuedCount: Number(row.issued_count),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type SaveTemplateInput = {
  concertId: number;
  templateId: number;
  name: string;
  layout: Layout;
  /** Null clears the background; undefined leaves it as it is. */
  backgroundAssetPath?: string | null;
};

export type SaveTemplateResult = {
  templateId: number;
  version: number;
  /** True when the save had to clone because this version had issued tickets. */
  cloned: boolean;
};

/**
 * Save an edit — **in place if nothing has been issued against this version,
 * as a new version if anything has** (spec/tickets.md §10.5).
 *
 * §10.5 states the rule as "never mutate a template that has already issued
 * tickets; clone it", and the condition is the whole of it. A template nobody
 * has been ticketed against has no copy anywhere to disagree with, so rewriting
 * it is invisible and keeps version numbers meaningful — otherwise every stray
 * nudge of a text box during an afternoon's work would mint a version, and
 * "version 34" would tell an admin nothing about what changed.
 *
 * The moment one attendee pins `(id, version)`, that row is frozen for good:
 * their PDF is already rendered from it on demand, and the copy in their inbox
 * has to keep agreeing with it.
 *
 * **The check and the write are one transaction**, and the count is taken with
 * `for update` on the template row. Without that, a blast that issues tickets
 * between the count and the update would leave those attendees pinned to a
 * version whose layout had just changed underneath them — which is exactly the
 * failure §10.5 exists to prevent, arriving through a race instead of a design
 * mistake.
 */
export async function saveTemplate(input: SaveTemplateInput): Promise<SaveTemplateResult> {
  const { concertId, templateId, name, layout, backgroundAssetPath } = input;
  const parsed = parseLayout(layout);

  try {
    return await getDb().transaction(async (tx) => {
      const currentRows = await tx.execute<{
        id: string;
        name: string;
        version: number;
        is_default: boolean;
        background_asset_path: string | null;
      }>(sql`
        select id, name, version, is_default, background_asset_path
          from ticket_templates
         where id = ${templateId}
           and concert_id = ${concertId}
           and deleted_at is null
           for update
      `);
      const current = currentRows[0];
      if (!current) throw new Error('That template no longer exists.');

      const path =
        backgroundAssetPath === undefined ? current.background_asset_path : backgroundAssetPath;
      const kind = backgroundKindOf(path);

      const issued = await tx.execute<{ count: string }>(sql`
        select count(*) as count from attendees
         where ticket_template_id = ${templateId}
           and ticket_template_version = ${current.version}
      `);

      if (Number(issued[0]?.count ?? 0) === 0) {
        await tx.execute(sql`
          update ticket_templates
             set name = ${name},
                 layout = ${JSON.stringify(parsed)}::text::jsonb,
                 background_asset_path = ${path},
                 background_kind = ${kind},
                 page_width_pt = ${Math.round(parsed.canvas.width_pt)},
                 page_height_pt = ${Math.round(parsed.canvas.height_pt)}
           where id = ${templateId}
        `);
        return { templateId, version: current.version, cloned: false };
      }

      /**
       * The next version of this lineage, not of this name.
       *
       * `(concert_id, name, version)` is unique, so a rename that collides with
       * another lineage's name would otherwise fail on the index with a
       * constraint error an admin cannot act on. Taking the maximum across both
       * the old and the new name keeps the insert legal either way.
       */
      const next = await tx.execute<{ version: number }>(sql`
        select coalesce(max(version), 0) + 1 as version
          from ticket_templates
         where concert_id = ${concertId}
           and name in (${current.name}, ${name})
      `);

      const inserted = await tx.execute<{ id: string; version: number }>(sql`
        insert into ticket_templates (
          concert_id, name, version, supersedes_id, background_asset_path,
          background_kind, page_width_pt, page_height_pt, layout, is_default
        ) values (
          ${concertId},
          ${name},
          ${next[0]?.version ?? current.version + 1},
          ${templateId},
          ${path},
          ${kind},
          ${Math.round(parsed.canvas.width_pt)},
          ${Math.round(parsed.canvas.height_pt)},
          ${JSON.stringify(parsed)}::text::jsonb,
          ${current.is_default}
        )
        returning id, version
      `);

      const row = inserted[0];
      if (!row) throw new Error('The new template version could not be created.');

      /**
       * The flag **moves** to the new version; it is not copied.
       *
       * Leaving it on both looked harmless, because `findConcertTemplate()`
       * takes the highest version among flagged rows and would still resolve to
       * this one. But that query orders across *names* too, so a second flagged
       * lineage would then resolve by version number rather than by anybody's
       * choice — and `setDefaultTemplate()` and `domain.md` §5.1 both describe a
       * concert as having exactly one default. A QA pass found the duplicate.
       */
      if (current.is_default) {
        await tx.execute(sql`
          update ticket_templates set is_default = false where id = ${templateId}
        `);
      }

      return { templateId: Number(row.id), version: row.version, cloned: true };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * `background_kind` follows the stored path and is never passed in separately.
 *
 * Two columns describing one fact drift: `background_kind = 'PDF'` beside a
 * `.png` path sends the renderer down the wrong branch, and the ticket comes out
 * blank. Deriving it from the extension this module wrote makes that
 * unrepresentable.
 */
function backgroundKindOf(path: string | null): AssetKind | 'NONE' {
  if (!path) return 'NONE';
  const contentType = contentTypeOf(path);
  if (!contentType) return 'NONE';
  return contentType === 'application/pdf' ? 'PDF' : 'IMAGE';
}

/**
 * Make one template the concert's default (spec/domain.md §5.1).
 *
 * Exactly one row per concert carries the flag. `findConcertTemplate()` takes
 * the highest version among flagged rows, so leaving an older version flagged
 * would be harmless today — but it also picks across *names*, and two flagged
 * lineages would then resolve by version number rather than by anybody's
 * choice.
 */
export async function setDefaultTemplate(concertId: number, templateId: number): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: ticketTemplates.id, name: ticketTemplates.name })
      .from(ticketTemplates)
      .where(
        and(
          eq(ticketTemplates.id, templateId),
          eq(ticketTemplates.concertId, concertId),
          isNull(ticketTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new Error('That template no longer exists.');

    await tx.execute(sql`
      update ticket_templates set is_default = false
       where concert_id = ${concertId} and is_default
    `);
    await tx.execute(sql`
      update ticket_templates set is_default = true where id = ${templateId}
    `);
  });
}

/**
 * Delete a ticket template (spec/tickets.md §10.5).
 *
 * **Soft, and refused in two cases**, both of which protect a ticket somebody
 * is already holding:
 *
 * - **A version any ticket is pinned to cannot be deleted.** `ticket_template_id`
 *   and `ticket_template_version` are pinned at issue time precisely so a later
 *   edit cannot change a ticket already in circulation, and reissuing re-renders
 *   from that pinned row. Deleting it would leave a delivered ticket unable to
 *   re-render — the one thing the pinning exists to prevent. The admin is told
 *   how many, because that number is the decision.
 * - **The default cannot be deleted.** It is what `resolveTemplateForShow()`
 *   falls back to, so removing it makes the next issue fail with a question
 *   about templates rather than about the ticket being issued. Naming a new
 *   default first is one click and leaves the concert always able to issue.
 *
 * Unversioned drafts and abandoned duplicates — the templates this exists for —
 * are pinned by nothing and are not the default, so they simply go.
 */
export async function deleteTemplate(concertId: number, templateId: number): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      name: string;
      version: number;
      is_default: boolean;
      issued: number;
    }>(sql`
      select t.name, t.version, t.is_default,
             (select count(*)::int from attendees a
               where a.ticket_template_id = t.id
                 and a.ticket_template_version = t.version) as issued
        from ticket_templates t
       where t.id = ${templateId}
         and t.concert_id = ${concertId}
         and t.deleted_at is null
    `);
    const template = rows[0];
    if (!template) throw new Error('That template no longer exists.');

    if (template.issued > 0) {
      throw new Error(
        `${template.issued} ticket${template.issued === 1 ? ' is' : 's are'} pinned to ` +
          `"${template.name}" v${template.version}, and reissuing one re-renders from it. ` +
          'Templates already in use cannot be deleted — duplicate it instead if you want ' +
          'to start from its design.',
      );
    }

    if (template.is_default) {
      throw new Error(
        `"${template.name}" is the default template, and new tickets are issued from it. ` +
          'Make another template the default first, then delete this one.',
      );
    }

    await tx.execute(sql`
      update ticket_templates set deleted_at = now() where id = ${templateId}
    `);
  });
}

/**
 * Copy a template into a new lineage, so an admin can experiment without
 * touching the one their tickets resolve through.
 *
 * A fresh lineage rather than a version: `supersedes_id` is null and the version
 * restarts at 1, because this is not an edit of the original — nothing about it
 * should look like history the original shares.
 */
export async function duplicateTemplate(
  concertId: number,
  templateId: number,
): Promise<{ templateId: number }> {
  const source = await loadTemplate(concertId, templateId);
  if (!source) throw new Error('That template no longer exists.');

  const existing = await getDb()
    .select({ name: ticketTemplates.name })
    .from(ticketTemplates)
    .where(and(eq(ticketTemplates.concertId, concertId), isNull(ticketTemplates.deletedAt)));
  const taken = new Set(existing.map((row) => row.name));

  let name = `${source.name} copy`;
  for (let n = 2; taken.has(name); n += 1) name = `${source.name} copy ${n}`;

  try {
    const rows = await getDb().execute<{ id: string }>(sql`
      insert into ticket_templates (
        concert_id, name, version, background_asset_path, background_kind,
        page_width_pt, page_height_pt, layout, is_default
      ) values (
        ${concertId}, ${name}, 1,
        ${source.backgroundAssetPath},
        -- Derived, like everywhere else: copying the source's column was the
        -- one place the kind was passed rather than computed, so a row whose
        -- kind had drifted from its path propagated the drift into a new
        -- lineage.
        ${backgroundKindOf(source.backgroundAssetPath)},
        ${source.pageWidthPt}, ${source.pageHeightPt},
        ${JSON.stringify(source.layout)}::text::jsonb,
        false
      )
      returning id
    `);
    const row = rows[0];
    if (!row) throw new Error('The template could not be duplicated.');
    return { templateId: Number(row.id) };
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * The attendee whose name is longest in a show, and one real attendee, for the
 * two previews §10.3 asks for.
 *
 * The longest name is the point: overflow is otherwise discovered at four
 * hundred tickets, by which time they are in four hundred inboxes. `length` is
 * a proxy for rendered width — the renderer measures glyphs properly — but it
 * finds the row worth looking at, which is all the editor needs.
 */
export type PreviewAttendee = {
  id: number;
  fullName: string;
  ticketCode: string | null;
  qrToken: string | null;
  contactName: string | null;
  playerName: string | null;
  playerInstrument: string | null;
};

export async function previewAttendees(showId: number): Promise<{
  first: PreviewAttendee | null;
  longestName: PreviewAttendee | null;
}> {
  const db = getDb();
  const select = sql`
    select a.id, a.full_name, a.ticket_code, a.qr_token,
           r.contact_name, p.full_name as player_name, p.instrument as player_instrument
      from attendees a
      join registrations r on r.id = a.registration_id
      left join players p on p.id = r.player_id
     where a.show_id = ${showId}
       and a.deleted_at is null
       and r.deleted_at is null
  `;

  type Row = {
    id: string;
    full_name: string;
    ticket_code: string | null;
    qr_token: string | null;
    contact_name: string | null;
    player_name: string | null;
    player_instrument: string | null;
  };

  const [firstRows, longestRows] = await Promise.all([
    db.execute<Row>(sql`${select} order by a.id asc limit 1`),
    db.execute<Row>(sql`${select} order by length(a.full_name) desc, a.id asc limit 1`),
  ]);

  const toAttendee = (row: Row | undefined): PreviewAttendee | null =>
    row
      ? {
          id: Number(row.id),
          fullName: row.full_name,
          ticketCode: row.ticket_code,
          qrToken: row.qr_token,
          contactName: row.contact_name,
          playerName: row.player_name,
          playerInstrument: row.player_instrument,
        }
      : null;

  return { first: toAttendee(firstRows[0]), longestName: toAttendee(longestRows[0]) };
}

/** Shows in a concert, for the editor's preview picker. */
export async function previewShows(concertId: number) {
  return getDb().execute<{
    id: string;
    name: string;
    starts_at: string | null;
    doors_open_at: string | null;
    venue_name: string | null;
    venue_address: string | null;
  }>(sql`
    select id, name, starts_at, doors_open_at, venue_name, venue_address
      from shows
     where concert_id = ${concertId} and deleted_at is null
     order by starts_at asc nulls last, name asc
  `);
}

/** Every template lineage's newest version, for the cascade's template picker. */
export async function newestTemplates(concertId: number) {
  return getDb()
    .select({
      id: ticketTemplates.id,
      name: ticketTemplates.name,
      version: ticketTemplates.version,
    })
    .from(ticketTemplates)
    .where(and(eq(ticketTemplates.concertId, concertId), isNull(ticketTemplates.deletedAt)))
    .orderBy(asc(ticketTemplates.name), desc(ticketTemplates.version));
}

/** Attendees pinned to a template version — what makes a save clone. */
export async function issuedAgainst(templateId: number, version: number): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<string>`count(*)` })
    .from(attendees)
    .where(
      and(
        eq(attendees.ticketTemplateId, templateId),
        eq(attendees.ticketTemplateVersion, version),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}
