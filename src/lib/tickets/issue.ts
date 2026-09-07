import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { bindingsUsed, parseLayout, type Binding } from './layout';
import { mintIdentifiers } from './mint';
import { idList, scopeFilter, ticketable, type TicketScope } from './scope';
import { resolveTemplateForShow, type ResolvedTemplate } from './seed-templates';

/**
 * Issuing a ticket, and keeping an issued one honest
 * (spec/tickets.md §10.5, §10.6).
 *
 * Both mechanisms here exist for one reason: **PDFs are rendered on demand, not
 * stored** (§10.4, to stay inside free storage limits). A stored PDF could not
 * drift from what was sent. A regenerated one can, in two ways — the template
 * changes underneath it, or the data does — and each way has its own guard.
 */

export type IssueScope = TicketScope & { concertId: number };

export type IssueResult = {
  /** Attendees that received identifiers on this call. */
  minted: number;
  /** Attendees whose template version was pinned on this call. */
  pinned: number;
  /** What each show in scope resolved to, keyed by show id. */
  templates: Record<number, ResolvedTemplate>;
};

/**
 * Mint identifiers and pin the template version for everyone in scope.
 *
 * **Pinning is the point.** `attendees.ticket_template_id` and
 * `ticket_template_version` are written once, at issue time, and rendering
 * always uses that pair — so an admin editing a template afterwards affects
 * only tickets issued later. Without it, the PDF in someone's inbox and the PDF
 * behind their portal link would silently disagree, and the door would be
 * scanning against a design nobody sent.
 *
 * Idempotent: a second call mints nothing (the token is already there) and
 * re-pins nothing (`where ticket_template_id is null`). Pressing the button
 * twice before a blast must be harmless.
 */
export async function issueTickets(scope: IssueScope): Promise<IssueResult> {
  const shows = await showsInScope(scope);

  let minted = 0;
  let pinned = 0;
  const templates: Record<number, ResolvedTemplate> = {};

  /**
   * **One template per show, not one per call.** `domain.md` §5.1 lets a single
   * show override its concert's template, so two shows in the same scope can
   * legitimately pin different ones. Resolving once for the whole scope would
   * quietly give every attendee the first show's design — and the wrong
   * template is *pinned*, so it would survive being corrected.
   */
  for (const showId of shows) {
    const template = await resolveTemplateForShow(showId);
    templates[showId] = template;
    minted += (await mintIdentifiers({ ...scope, showId })).minted;

    try {
      const rows = await getDb().execute<{ id: string }>(sql`
        update attendees a
           set ticket_template_id = ${template.id},
               ticket_template_version = ${template.version},
               ticket_issued_at = coalesce(a.ticket_issued_at, now())
          from registrations r
         where r.id = a.registration_id
           and a.show_id = ${showId}
           and a.qr_token is not null
           -- Never re-pin. An attendee already pinned holds a ticket rendered
           -- against that version, and moving them to a newer one changes a PDF
           -- someone may already be holding. Repinning is an explicit admin
           -- action — reissueTickets() below — which also resends.
           and a.ticket_template_id is null
           and ${scopeFilter(scope, { require: false })}
           and ${ticketable()}
        returning a.id
      `);
      pinned += rows.length;
    } catch (error) {
      rethrowDbError(error);
    }
  }

  return { minted, pinned, templates };
}

export type ReissueResult = {
  /** Attendees repinned to the current template. */
  repinned: number;
  /**
   * Attendees whose `ticket_sent_at` was cleared, and who therefore re-enter
   * the pending bucket for the next blast.
   */
  requeued: number;
  templates: Record<number, ResolvedTemplate>;
};

/**
 * Repin issued tickets to the concert's current template, and queue a resend.
 *
 * §10.5: re-rendering an already-issued ticket against a newer template is
 * possible but **explicit** — this is the "Reissue tickets with current
 * template" admin action. It repins the version, clears `ticket_sent_at` for
 * the affected attendees so they leave the delivered bucket, and clears
 * `needs_reissue`. It refuses to run silently, which is why it is a separate
 * function from {@link issueTickets} rather than a flag on it.
 *
 * **It never touches `qr_token`** (§10.1 rule 3, decision 28). The database
 * enforces that too — `attendees_qr_token_immutable` — but the statement below
 * does not name the column at all, which is the first line of defence.
 *
 * Clearing `ticket_sent_at` is what makes the resend happen: the outbox treats
 * it as the per-seat delivery truth and the dedup key for repeat blasts
 * (spec/email.md §11.4). A reissue that repinned without clearing it would
 * leave the recipient holding a stale PDF with nothing to say so.
 */
export async function reissueTickets(scope: IssueScope): Promise<ReissueResult> {
  const shows = await showsInScope(scope);
  let repinned = 0;
  let requeued = 0;
  const templates: Record<number, ResolvedTemplate> = {};

  for (const showId of shows) {
    const template = await resolveTemplateForShow(showId);
    templates[showId] = template;

    try {
      /**
       * The `target` CTE snapshots `ticket_sent_at` **before** the update.
       *
       * `RETURNING` reports the new row, so reading the column there would
       * always see the null this statement just wrote and report zero resends
       * every time. The count matters: it is what tells an admin how many
       * people are about to get a second email, and silently reporting none is
       * how a reissue looks like it did nothing.
       */
      const rows = await getDb().execute<{ id: string; was_sent: boolean }>(sql`
        with target as (
          select a.id, a.ticket_sent_at
            from attendees a
            join registrations r on r.id = a.registration_id
           where a.show_id = ${showId}
             and a.qr_token is not null
             and ${scopeFilter(scope, { require: false })}
             and ${ticketable()}
        )
        update attendees a
           set ticket_template_id = ${template.id},
               ticket_template_version = ${template.version},
               ticket_sent_at = null,
               ticket_sent_source = null,
               needs_reissue = false
          from target
         where a.id = target.id
        returning a.id, (target.ticket_sent_at is not null) as was_sent
      `);
      repinned += rows.length;
      requeued += rows.filter((r) => r.was_sent).length;
    } catch (error) {
      rethrowDbError(error);
    }
  }

  return { repinned, requeued, templates };
}

/**
 * The distinct shows a scope touches.
 *
 * Template resolution is per show (`domain.md` §5.1), so every mutation here
 * works show by show rather than assuming the scope names exactly one.
 */
async function showsInScope(scope: IssueScope): Promise<number[]> {
  const rows = await getDb().execute<{ show_id: string }>(sql`
    select distinct a.show_id
      from attendees a
      join registrations r on r.id = a.registration_id
      join shows s on s.id = a.show_id
     where s.concert_id = ${scope.concertId}
       and ${scopeFilter(scope, { require: false })}
       and ${ticketable()}
     order by a.show_id
  `);
  return rows.map((r) => Number(r.show_id));
}

/**
 * Flag attendees whose printed data no longer matches their record (§10.6).
 *
 * The data half of the same trap. If an attendee's name is corrected after the
 * PDF is in someone's inbox, the ticket they hold and the ticket the system
 * would render disagree. So an edit to a field **bound into their pinned
 * template** marks `needs_reissue` rather than silently diverging; the admin
 * sees a count and resolves it deliberately — reissue and resend, or dismiss as
 * cosmetic.
 *
 * Only attendees with `ticket_sent_at` set are flagged. An unsent ticket has
 * not reached anyone, so there is nothing to disagree with — it simply renders
 * correctly when it does go out.
 *
 * The door is unaffected either way: check-in matches on `qr_token`, which
 * never changes.
 *
 * Called by whichever module edits the field. `changedFields` are binding names
 * (§10.2), so a caller says what it changed in the template's own vocabulary
 * rather than in column names.
 */
export async function flagReissueForChangedFields(
  attendeeIds: number[],
  changedFields: Binding[],
): Promise<number> {
  if (attendeeIds.length === 0 || changedFields.length === 0) return 0;

  const db = getDb();

  // Which of those fields each attendee's own pinned template actually prints.
  // A concert whose template never shows `player.instrument` should not raise a
  // reissue count when an instrument is corrected — the ticket does not carry
  // it, so nothing diverged.
  const rows = await db.execute<{ id: string; layout: unknown }>(sql`
    select a.id, t.layout
      from attendees a
      join ticket_templates t on t.id = a.ticket_template_id
     where a.id in ${idList(attendeeIds)}
       and a.ticket_sent_at is not null
       and a.deleted_at is null
  `);

  const affected = rows
    .filter((row) => {
      const used = bindingsUsed(parseLayout(row.layout));
      return changedFields.some((field) => used.has(field));
    })
    .map((row) => Number(row.id));

  if (affected.length === 0) return 0;

  try {
    const updated = await db.execute<{ id: string }>(sql`
      update attendees set needs_reissue = true
       where id in ${idList(affected)}
         and needs_reissue = false
      returning id
    `);
    return updated.length;
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Clear the reissue flag **without** re-rendering or resending (§10.6).
 *
 * > Admin sees a "N tickets need reissuing" count and resolves it deliberately —
 * > reissue and resend, or **dismiss as cosmetic**.
 *
 * This is the second exit, and without it the banner has only one: a full
 * resend. That matters because most flagged changes are cosmetic — a corrected
 * spelling, a tidied capitalisation — and forcing a resend for those means
 * either emailing a whole show again over a typo, or leaving the count standing
 * until people stop reading it.
 *
 * Deliberately narrow: it changes `needs_reissue` and nothing else. The ticket
 * the guest holds stays exactly as sent, which is the point of calling it
 * cosmetic, and the door is unaffected either way because check-in matches on
 * `qr_token`.
 */
export async function dismissReissue(scope: IssueScope): Promise<number> {
  try {
    const rows = await getDb().execute<{ id: string }>(sql`
      update attendees a
         set needs_reissue = false
        from registrations r, shows s
       where r.id = a.registration_id
         and s.id = a.show_id
         -- Tie the rows to the concert the caller named. Without it a list of
         -- attendee ids reaches straight past the concert boundary, and the ids
         -- come from a request body.
         and s.concert_id = ${scope.concertId}
         and a.needs_reissue
         and ${scopeFilter(scope, { require: false })}
         and a.deleted_at is null
         and r.deleted_at is null
      returning a.id
    `);
    return rows.length;
  } catch (error) {
    rethrowDbError(error);
  }
}

/** How many tickets in scope are waiting to be reissued (§10.6's count). */
export async function countNeedingReissue(scope: TicketScope): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
      from attendees a
      join registrations r on r.id = a.registration_id
     where a.needs_reissue
       and a.deleted_at is null
       and r.deleted_at is null
       and ${scopeFilter(scope)}
  `);
  return rows[0]?.n ?? 0;
}
