import { redirect } from 'next/navigation';

/**
 * `/email/delivery` — V1's page for correcting `ticket_sent_at` by hand
 * (spec/email.md §11.6), which nothing linked to (`local.md` §14.2).
 *
 * Retired by V3 (spec/v3.md §24.4): Mark delivered by hand and Resend are
 * Delivery commands on any Audience selection and on the party record, and a
 * failed or bounced message is repaired from Audience › Messages. Kept as a
 * redirect for old links.
 */
export default async function RetiredPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/audience/messages?status=FAILED`);
}
