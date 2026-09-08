import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { TicketData } from './bindings';
import { parseLayout, type Layout } from './layout';

/**
 * `APP_URL`, read directly rather than through `src/lib/env.ts`.
 *
 * That module validates the whole environment at once, so importing it here
 * would make rendering a ticket require the Supabase keys — which a test, a
 * script, or a local render has no business needing. `src/db/client.ts` reads
 * `DATABASE_URL` the same way and for the same reason.
 *
 * The value is baked into every QR at issue time and cannot be corrected
 * afterwards (§10.1 rule 5), so an absent one fails loudly here rather than
 * producing a plausible ticket pointing nowhere.
 */
function requireAppUrl(): string {
  const value = process.env.APP_URL;
  if (!value) {
    throw new Error(
      'APP_URL is not set, so the QR would carry no origin. It must be the ' +
        'Vercel production alias and never VERCEL_URL (spec/tickets.md §10.1).',
    );
  }
  /**
   * **A per-deployment hostname is refused outright** (§10.1 Rule A,
   * decision 30). `<project>-<hash>-<scope>.vercel.app` changes on every deploy
   * and is dead within days, so a ticket rendered against one is born broken —
   * and unrecallable, because the origin is baked in at issue time.
   *
   * Nothing else stops it: `VERCEL_URL` holds exactly that hostname, and
   * `APP_URL ?? VERCEL_URL` is a one-line change that looks like a sensible
   * fallback and passes every other check.
   */
  if (/-[0-9a-z]{6,}-[^.]+\.vercel\.app/i.test(value)) {
    throw new Error(
      `APP_URL looks like a per-deployment Vercel hostname: ${value}. It must ` +
        'be the production alias (zetix.vercel.app). A deployment URL is ' +
        'dead within days and is baked into every ticket permanently ' +
        '(spec/tickets.md §10.1 Rule A).',
    );
  }
  return value;
}

/**
 * Loading everything one ticket needs, in a single query.
 *
 * The renderer takes a plain object so it can be tested without a database
 * (`bindings.ts`); this is the one place that fills that object from real rows.
 * One query rather than several because a blast renders hundreds of these and
 * every extra round trip is multiplied by the party count.
 */

export type LoadedTicket = {
  attendeeId: number;
  concertId: number;
  showId: number;
  /**
   * The pinned template — never the concert's current one (§10.5).
   *
   * The artwork travels with it rather than being resolved separately, for the
   * same reason the layout does: a ticket must render against the background
   * the pinned version was designed over, not against whatever the template's
   * newest version now points at.
   */
  template: {
    id: number;
    version: number;
    layout: Layout;
    backgroundAssetPath: string | null;
    backgroundKind: 'IMAGE' | 'PDF' | 'NONE';
  };
  data: TicketData;
  /** Filename for a download, per spec/email.md §11.3. */
  filename: string;
};

export async function loadTicket(attendeeId: number): Promise<LoadedTicket | null> {
  const rows = await getDb().execute<{
    attendee_id: string;
    concert_id: string;
    show_id: string;
    full_name: string;
    ticket_code: string | null;
    qr_token: string | null;
    contact_name: string | null;
    player_name: string | null;
    player_instrument: string | null;
    show_name: string;
    starts_at: string | null;
    doors_open_at: string | null;
    venue_name: string | null;
    venue_address: string | null;
    concert_name: string;
    timezone: string | null;
    template_id: string | null;
    template_version: number | null;
    layout: unknown;
    background_asset_path: string | null;
    background_kind: 'IMAGE' | 'PDF' | 'NONE' | null;
  }>(sql`
    select
      a.id                as attendee_id,
      c.id                as concert_id,
      s.id                as show_id,
      a.full_name,
      a.ticket_code,
      a.qr_token,
      r.contact_name,
      p.full_name         as player_name,
      p.instrument        as player_instrument,
      s.name              as show_name,
      s.starts_at,
      s.doors_open_at,
      s.venue_name,
      s.venue_address,
      c.name              as concert_name,
      c.timezone,
      t.id                as template_id,
      t.version           as template_version,
      t.layout,
      t.background_asset_path,
      t.background_kind
    from attendees a
    join registrations r on r.id = a.registration_id
    join shows s         on s.id = a.show_id
    join concerts c      on c.id = s.concert_id
    -- A public registration has no player, and a ticket not yet issued has no
    -- pinned template. Both are ordinary states, so both joins are outer: an
    -- inner join here would make an unissued ticket un-previewable, which is
    -- exactly the row an admin most wants to look at before a blast.
    left join players p        on p.id = r.player_id
    -- **Both halves of the pin**, not just the id (§10.5). Each row is one
    -- immutable version, so the id alone happens to identify the version today
    -- — but that holds only while module E clones instead of mutating, and E
    -- is being built in parallel against the written spec rather than against
    -- this code. Joining on the version too turns "E mutated a row" from a
    -- silently different ticket into a row this refuses to render.
    left join ticket_templates t
           on t.id = a.ticket_template_id
          and t.version = a.ticket_template_version
    where a.id = ${attendeeId}
      and a.deleted_at is null
    limit 1
  `);

  const row = rows[0];
  if (!row) return null;
  if (!row.template_id || !row.layout) return null;

  const timezone = row.timezone;
  if (!timezone) {
    // Every printed timestamp resolves in the concert's zone (CLAUDE.md). With
    // none set there is no correct answer, and guessing prints a doors time
    // that is wrong by hours on a ticket nobody can recall.
    throw new Error(
      `Concert ${row.concert_id} has no timezone, so a ticket cannot be rendered ` +
        'for it. Set it on the concert before issuing.',
    );
  }

  const data: TicketData = {
    attendee: {
      fullName: row.full_name,
      ticketCode: row.ticket_code,
      qrToken: row.qr_token,
    },
    registration: { contactName: row.contact_name },
    player: row.player_name
      ? { fullName: row.player_name, instrument: row.player_instrument }
      : null,
    show: {
      name: row.show_name,
      startsAt: row.starts_at ? new Date(row.starts_at) : null,
      doorsOpenAt: row.doors_open_at ? new Date(row.doors_open_at) : null,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
    },
    concert: { name: row.concert_name, timezone },
    appUrl: requireAppUrl(),
  };

  return {
    attendeeId: Number(row.attendee_id),
    concertId: Number(row.concert_id),
    showId: Number(row.show_id),
    template: {
      id: Number(row.template_id),
      version: row.template_version ?? 1,
      layout: parseLayout(row.layout),
      backgroundAssetPath: row.background_asset_path,
      backgroundKind: row.background_kind ?? 'NONE',
    },
    data,
    filename: ticketFilename(row.show_name, row.full_name, row.ticket_code),
  };
}

/**
 * `{show}-{name}-{ticket_code}.pdf` (spec/email.md §11.3).
 *
 * Sanitised because it becomes both an email attachment name and a
 * `Content-Disposition` value: a slash makes some clients treat it as a path,
 * and a quote or newline would break the header outright.
 */
export function ticketFilename(
  showName: string,
  fullName: string,
  ticketCode: string | null,
): string {
  const slug = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'ticket';
  return `${slug(showName)}-${slug(fullName)}${ticketCode ? `-${ticketCode}` : ''}.pdf`;
}
