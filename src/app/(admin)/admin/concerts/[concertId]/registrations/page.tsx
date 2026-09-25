import { redirect } from 'next/navigation';

/**
 * `/registrations` — the V1/V2 registrations table.
 *
 * Retired by the Audience workspace (spec/v3.md §22.1): its work is now a view,
 * commands and the party record. Kept as a redirect so bookmarks and links in
 * old messages still land somewhere useful.
 */
export default async function RetiredPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/audience`);
}
