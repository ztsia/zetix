import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireAdmin } from '@/lib/auth/guards';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { formatInZone, ticketLinks } from '@/lib/email/queue';
import { toNameCase } from '@/lib/names';
import { TEMPLATE_KEYS } from '@/lib/email/templates';
import { Button } from '@/components/ui/button';
import { TemplateEditor, type PreviewRecipient } from './template-editor';

export const metadata: Metadata = { title: 'Email templates' };

/**
 * `/admin/concerts/{id}/email/templates` — the editor of §11.3.
 *
 * Templates are seeded lazily on first view, so the system can send before
 * anyone has opened this screen (the argument decision 10 makes for ticket
 * templates). Seeding never overwrites, so opening this page cannot undo an
 * edit.
 */
export default async function TemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<{ key?: string }>;
}) {
  await requireAdmin();

  const { concertId: rawConcertId } = await params;
  const concertId = Number(rawConcertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  await seedDefaultTemplates();

  const { key } = await searchParams;
  const templateKey = TEMPLATE_KEYS.includes(key as never) ? (key as string) : 'public_ticket';

  const db = getDb();
  const rows = await db.execute<{ key: string; name: string; subject: string; body_md: string }>(sql`
    select key, name, subject, body_md from email_templates where key = ${templateKey}
  `);
  if (rows.length === 0) notFound();

  /**
   * §11.5: preview against a **real** recipient, "with a 'longest name' and a
   * 'no player linked' case in the picker — template bugs are almost always
   * data-shape bugs".
   *
   * Both are selected by the database rather than assembled here, so the picker
   * offers rows that genuinely exist in this concert.
   */
  const previewRows = await db.execute<{
    label: string;
    concert_name: string;
    show_name: string;
    starts_at: string | null;
    doors_open_at: string | null;
    timezone: string;
    venue_name: string | null;
    venue_address: string | null;
    segment_name: string;
    contact_name: string | null;
    contact_email: string;
    round_label: string | null;
    attendee_count: number;
    attendee_names: string[];
    link_names: string[] | null;
    qr_tokens: string[] | null;
    admitted_count: number;
    admitted_names: string[] | null;
    admitted_tokens: string[] | null;
  }>(sql`
    (select 'Longest name: ' || coalesce(r.contact_name, '(none)') as label,
            c.name as concert_name, s.name as show_name,
            s.starts_at, s.doors_open_at, c.timezone, s.venue_name, s.venue_address,
            seg.name as segment_name, r.contact_name, r.contact_email, r.round_label,
            counts.attendee_count, counts.attendee_names, counts.link_names, counts.qr_tokens,
            counts.admitted_count, counts.admitted_names, counts.admitted_tokens
       from registrations r
       join show_segments seg on seg.id = r.segment_id
       join shows s on s.id = r.show_id
       join concerts c on c.id = s.concert_id
       join lateral (
         select count(*)::int as attendee_count,
                coalesce(array_agg(a.full_name order by a.id), '{}') as attendee_names,
                -- Untokened seats are dropped from the link pair here exactly
                -- as queue.ts does it: postgres.js reads a NULL element of a
                -- text array back as the string "NULL", which previews as a
                -- live /t/NULL link. Both aggregates share the filter so the
                -- names and tokens stay index-aligned.
                array_agg(a.full_name order by a.id)
                  filter (where a.qr_token is not null) as link_names,
                array_agg(a.qr_token order by a.id)
                  filter (where a.qr_token is not null) as qr_tokens,
                -- The feedback message is addressed to the seats that were
                -- ADMITTED, never the whole party (spec/v2.md 13.5.1), so its
                -- two tokens preview through the same check_ins predicate
                -- loadFeedbackRecipients uses -- including the reverted_at is
                -- null, because an undone mis-scan is not an admission.
                -- Previewing from the whole party instead would show a link
                -- list longer than the blast will send.
                -- (No backticks in here: this is inside a tagged template.)
                count(*) filter (
                  where exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                )::int as admitted_count,
                array_agg(a.full_name order by a.id) filter (
                  where a.qr_token is not null
                    and exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                ) as admitted_names,
                array_agg(a.qr_token order by a.id) filter (
                  where a.qr_token is not null
                    and exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                ) as admitted_tokens
           from attendees a where a.registration_id = r.id and a.deleted_at is null
       ) counts on true
      where s.concert_id = ${concertId} and r.deleted_at is null
      order by length(coalesce(r.contact_name, '')) desc, r.id
      limit 1)
    union all
    (select 'No player linked: ' || coalesce(r.contact_name, '(none)') as label,
            c.name, s.name,
            s.starts_at, s.doors_open_at, c.timezone, s.venue_name, s.venue_address,
            seg.name, r.contact_name, r.contact_email, r.round_label,
            counts.attendee_count, counts.attendee_names, counts.link_names, counts.qr_tokens,
            counts.admitted_count, counts.admitted_names, counts.admitted_tokens
       from registrations r
       join show_segments seg on seg.id = r.segment_id
       join shows s on s.id = r.show_id
       join concerts c on c.id = s.concert_id
       join lateral (
         select count(*)::int as attendee_count,
                coalesce(array_agg(a.full_name order by a.id), '{}') as attendee_names,
                -- Untokened seats are dropped from the link pair here exactly
                -- as queue.ts does it: postgres.js reads a NULL element of a
                -- text array back as the string "NULL", which previews as a
                -- live /t/NULL link. Both aggregates share the filter so the
                -- names and tokens stay index-aligned.
                array_agg(a.full_name order by a.id)
                  filter (where a.qr_token is not null) as link_names,
                array_agg(a.qr_token order by a.id)
                  filter (where a.qr_token is not null) as qr_tokens,
                -- The feedback message is addressed to the seats that were
                -- ADMITTED, never the whole party (spec/v2.md 13.5.1), so its
                -- two tokens preview through the same check_ins predicate
                -- loadFeedbackRecipients uses -- including the reverted_at is
                -- null, because an undone mis-scan is not an admission.
                -- Previewing from the whole party instead would show a link
                -- list longer than the blast will send.
                -- (No backticks in here: this is inside a tagged template.)
                count(*) filter (
                  where exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                )::int as admitted_count,
                array_agg(a.full_name order by a.id) filter (
                  where a.qr_token is not null
                    and exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                ) as admitted_names,
                array_agg(a.qr_token order by a.id) filter (
                  where a.qr_token is not null
                    and exists (select 1 from check_ins k
                                 where k.attendee_id = a.id and k.reverted_at is null)
                ) as admitted_tokens
           from attendees a where a.registration_id = r.id and a.deleted_at is null
       ) counts on true
      where s.concert_id = ${concertId} and r.deleted_at is null and r.player_id is null
      order by r.id
      limit 1)
  `);

  const recipients: PreviewRecipient[] = previewRows.map((row) => ({
    label: row.label,
    context: {
      'concert.name': row.concert_name,
      'show.name': row.show_name,
      // Formatted with the blast's own helper, not a stub. These two were
      // hardcoded to '' here, so the preview showed an empty "When:" line
      // whether or not the show had times — the one thing §11.5's preview is
      // for. If they still render blank, the show really has no times set.
      'show.starts_at': formatInZone(row.starts_at, row.timezone),
      'show.doors_open_at': formatInZone(row.doors_open_at, row.timezone),
      'show.venue_name': row.venue_name ?? '',
      'show.venue_address': row.venue_address ?? '',
      'segment.name': row.segment_name,
      // Cased exactly as `queue.ts` does it, or the preview would show a name
      // the blast is not going to send.
      'registration.contact_name': toNameCase(row.contact_name ?? ''),
      'registration.contact_email': row.contact_email,
      'registration.round_label': row.round_label ?? '',
      attendee_count: String(row.attendee_count),
      attendee_names: (row.attendee_names ?? []).filter(Boolean).map(toNameCase).join(', '),
      // Rendered from the real seats, not a stub: `ref.md` §6 — a template
      // bug is almost always a data-shape bug, and this token is the one that
      // changes shape with the size of the party.
      ticket_links: ticketLinks((row.link_names ?? []).map(toNameCase), row.qr_tokens),
      /**
       * **The feedback message's own two tokens, which previewed as blank.**
       *
       * Neither was in this map, so `feedback_request` -- the one template
       * whose entire body is a link list -- reported `{{ feedback_links }}` as
       * "blank for this recipient" on every row, and the warning's advice was
       * to drop it from the wording. Taking that advice sends four hundred
       * people a feedback email with no way to give feedback, which is §10 and
       * §12.1's failure a third time.
       *
       * Blank here now means what it says: this party had nobody admitted.
       */
      admitted_count: String(row.admitted_count),
      feedback_links: ticketLinks(
        (row.admitted_names ?? []).map(toNameCase),
        row.admitted_tokens,
      ),
    },
  }));

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Email templates</h1>
          <p className="text-muted-foreground text-sm">
            Markdown with merge fields. A plain-text alternative is generated when the message is sent.
          </p>
        </div>
        <Button variant="outline" render={<Link href={`/admin/concerts/${concertId}/email`} />}>
          Back to blast
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        {TEMPLATE_KEYS.map((templateName) => (
          <Button
            key={templateName}
            size="sm"
            variant={templateName === templateKey ? 'secondary' : 'ghost'}
            render={
              <Link href={`/admin/concerts/${concertId}/email/templates?key=${templateName}`} />
            }
          >
            {templateName}
          </Button>
        ))}
      </div>

      <TemplateEditor
        key={templateKey}
        templateKey={rows[0].key}
        name={rows[0].name}
        subject={rows[0].subject}
        bodyMd={rows[0].body_md}
        recipients={recipients}
      />
    </div>
  );
}
