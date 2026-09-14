import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { resolveSetting } from '@/db/settings';

/**
 * Registrations that were sent a verification link and have not clicked it
 * (spec/v2.md §8.1.4).
 *
 * **This screen is the bounce list, and that is why it earns its place.**
 * Nothing in the system reads delivery failures back — Gmail returns a DSN to
 * the sending mailbox and nobody parses it — so an address that is simply wrong
 * produces exactly one visible symptom anywhere: a registration that never
 * verifies. Everything upstream (syntax, whitespace repair, the MX and typo
 * checks at submit) narrows the odds; this is where what got through shows up.
 *
 * Seats are never at stake here. These parties are `CONFIRMED` and hold their
 * seats throughout; what is held is the ticket email.
 */

export type UnverifiedRegistration = {
  id: number;
  contactName: string;
  contactEmail: string;
  roundLabel: string | null;
  segmentName: string;
  showName: string;
  seats: number;
  requestedAt: string;
  hoursWaiting: number;
  /** Past `form.verification_grace_hours` — the ones §8.1.4 flags for review. */
  overdue: boolean;
};

export async function unverifiedRegistrations(
  concertId: number,
): Promise<{ rows: UnverifiedRegistration[]; graceHours: number | null }> {
  /**
   * Through the cascade, never off a column (`README.md` §2.2). Seeded at 48,
   * and **a missing value does not stop this screen** — unlike a repeater cap,
   * where guessing could oversell. Here it only decides which rows are styled
   * as overdue, so a null shows every waiting party with nothing marked.
   */
  const graceHours = await resolveSetting<number>('form.verification_grace_hours', { concertId });

  const rows = await getDb().execute<{
    id: string;
    contact_name: string;
    contact_email: string;
    round_label: string | null;
    segment_name: string;
    show_name: string;
    seats: number;
    requested_at: string;
    hours_waiting: number;
  }>(sql`
    select
      r.id,
      r.contact_name,
      r.contact_email,
      r.round_label,
      seg.name as segment_name,
      s.name as show_name,
      (select count(*)::int from attendees a
        where a.registration_id = r.id
          and a.status = 'CONFIRMED'
          and a.deleted_at is null) as seats,
      r.requested_at::text as requested_at,
      (extract(epoch from (now() - r.requested_at)) / 3600)::int as hours_waiting
    from registrations r
    join show_segments seg on seg.id = r.segment_id
    join shows s on s.id = r.show_id
    where s.concert_id = ${concertId}::bigint
      -- The same gate the blast applies, stated the same way: a registration is
      -- waiting only if it was actually sent a link. An import or a player form
      -- has no token and is not waiting for anything.
      and r.verification_token is not null
      and r.email_verified_at is null
      and r.status = 'CONFIRMED'
      and r.deleted_at is null
    order by r.requested_at asc
  `);

  return {
    graceHours,
    rows: rows.map((row) => ({
      id: Number(row.id),
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      roundLabel: row.round_label,
      segmentName: row.segment_name,
      showName: row.show_name,
      seats: Number(row.seats),
      requestedAt: row.requested_at,
      hoursWaiting: Number(row.hours_waiting),
      overdue: graceHours !== null && Number(row.hours_waiting) >= graceHours,
    })),
  };
}
