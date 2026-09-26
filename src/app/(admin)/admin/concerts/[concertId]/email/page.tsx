import { redirect } from 'next/navigation';

/**
 * `/email` — the V1 blast screen: segment, template, prepare, review, confirm,
 * send. Email templates stay at `/email/templates` until Setup takes them
 * (spec/v3.md §29.1).
 *
 * Retired by the send wizard (spec/v3.md §24.1): sending is Send tickets over
 * any Audience selection, and the outbox is Audience › Messages. Kept as a
 * redirect so bookmarks and links in old messages still land somewhere useful.
 */
export default async function RetiredPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/audience/messages`);
}
