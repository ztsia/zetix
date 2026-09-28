import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/commands/define';
import { writeAuditLog } from '@/lib/audit';
import { defaultTemplateFor, type AudienceMode } from '@/lib/delivery/purposes';
import { escapeMergeValues, renderTemplate } from '@/lib/email/render';
import { draftSuperseding, MessageInFlightError } from '@/lib/email/supersede';
import { templateFor } from '@/lib/email/template-row';
import { verificationUrl } from '@/lib/registrations/verification';
import { updateUrl } from './update-link';

/**
 * The receipt (spec/v3.md §25.3): what was received, that tickets follow once
 * the organisers confirm, and to check the spam folder.
 *
 * **Queued, not drafted** — it skips the `DRAFT` gate as the feedback email
 * does (decision 38, 54): no attachment, nothing irreplaceable, and a person
 * waiting to know it worked. It is **held** for `email.receipt_hold_minutes`
 * before it becomes due, so a second submission from the same address — merged
 * into the same party (§25.5) — supersedes it and one email covers every seat.
 *
 * **On a public form it carries the verification link**, one email rather than
 * two; `public_verify` stays for reminders. The link is left out once the
 * address is verified.
 *
 * Written in the caller's transaction: a party and its receipt land together.
 */

export type ReceiptOutcome =
  | { queued: true; id: number; superseded: number[] }
  /**
   * The earlier receipt is being handed to the mail server right now, so it
   * cannot be superseded. It already carries the verification link; what it
   * lacks is any seat this submission added, which the confirmation screen
   * shows. Rare — the window is the seconds a send takes.
   */
  | { queued: false; reason: 'IN_FLIGHT' | 'NO_TEMPLATE' | 'NO_ADDRESS' | 'NO_SEATS' };

type PartyRow = {
  contact_name: string;
  contact_email: string | null;
  verification_token: string | null;
  email_verified_at: string | null;
  update_token: string | null;
  segment_id: string;
  audience_mode: AudienceMode;
  stored_template: string | null;
  concert_name: string;
  show_name: string;
  segment_name: string;
  round_label: string | null;
  hold_minutes: unknown;
  names: string[] | null;
};

/**
 * Queue (or re-queue) the receipt for one party. `holdMinutes` overrides the
 * cascade — import passes zero, since nothing will collapse into its receipt.
 */
export async function queueReceipt(
  tx: Tx,
  registrationId: number,
  options: { holdMinutes?: number; actorId?: string | null } = {},
): Promise<ReceiptOutcome> {
  const [party] = await tx.execute<PartyRow>(sql`
    select
      r.contact_name,
      r.contact_email::text as contact_email,
      r.verification_token,
      r.email_verified_at::text as email_verified_at,
      r.update_token,
      r.segment_id,
      g.audience_mode::text as audience_mode,
      d.template_key as stored_template,
      c.name as concert_name,
      s.name as show_name,
      g.name as segment_name,
      r.round_label,
      resolve_setting('email.receipt_hold_minutes', r.segment_id, r.show_id, s.concert_id) as hold_minutes,
      (select array_agg(a.full_name order by a.id)
         from attendees a
        where a.registration_id = r.id and a.deleted_at is null and a.status <> 'CANCELLED') as names
    from registrations r
    join show_segments g on g.id = r.segment_id
    join shows s on s.id = r.show_id
    join concerts c on c.id = s.concert_id
    left join segment_message_defaults d on d.segment_id = r.segment_id and d.purpose = 'RECEIPT'
    where r.id = ${registrationId} and r.deleted_at is null
  `);
  if (!party?.contact_email) return { queued: false, reason: 'NO_ADDRESS' };
  const names = party.names ?? [];
  if (names.length === 0) return { queued: false, reason: 'NO_SEATS' };

  const templateKey = defaultTemplateFor('RECEIPT', party.audience_mode, party.stored_template);
  if (!templateKey) return { queued: false, reason: 'NO_TEMPLATE' };
  const template = await templateFor(tx, templateKey);
  if (!template) {
    console.error(`no "${templateKey}" email template: registration ${registrationId} got no receipt`);
    return { queued: false, reason: 'NO_TEMPLATE' };
  }

  const needsVerification = party.verification_token !== null && party.email_verified_at === null;
  const context = escapeMergeValues({
    'registration.contact_name': party.contact_name,
    'registration.contact_email': party.contact_email,
    'registration.round_label': party.round_label ?? '',
    'concert.name': party.concert_name,
    'show.name': party.show_name,
    'segment.name': party.segment_name,
    attendee_count: String(names.length),
    attendee_names: names.join(', '),
    verify_section: needsVerification
      ? `Please confirm this is your address: [Confirm my email address](${verificationUrl(party.verification_token!)})`
      : '',
    update_url: party.update_token ? updateUrl(party.update_token) : '',
  });

  const hold = options.holdMinutes ?? holdFrom(party.hold_minutes);
  const scheduledFor = hold > 0 ? new Date(Date.now() + hold * 60_000) : null;

  try {
    const { id, superseded } = await draftSuperseding(
      tx,
      {
        addressee: { registrationId },
        purpose: 'RECEIPT',
        templateKey,
        toEmail: party.contact_email,
        toName: party.contact_name,
        subject: renderTemplate(template.subject, context).text,
        bodyMd: renderTemplate(template.body_md, context).text,
        context,
        status: 'QUEUED',
        scheduledFor,
      },
      (entry) => writeAuditLog({ ...entry, actorId: options.actorId ?? null }, tx),
    );
    return { queued: true, id, superseded };
  } catch (error) {
    if (error instanceof MessageInFlightError) return { queued: false, reason: 'IN_FLIGHT' };
    throw error;
  }
}

/**
 * `email.receipt_hold_minutes` as resolved. Unset means no hold — the receipt
 * is due at once, which is the direction that costs nothing but a second email
 * if the person submits again.
 */
function holdFrom(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
