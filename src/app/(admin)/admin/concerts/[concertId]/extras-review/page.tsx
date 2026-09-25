import { redirect } from 'next/navigation';

/**
 * `/extras-review` — the V1 extras review board. Its pool meter is the Needs
 * review view's toolbar now (§22.2).
 *
 * Retired by the Audience workspace (spec/v3.md §22.1): its work is now a view,
 * commands and the party record. Kept as a redirect so bookmarks and links in
 * old messages still land somewhere useful.
 */
export default async function RetiredPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<{ segment?: string }>;
}) {
  const { concertId } = await params;
  const { segment } = await searchParams;
  const id = Number(segment);
  redirect(
    `/admin/concerts/${concertId}/audience?view=needs-review${Number.isSafeInteger(id) && id > 0 ? `&segment=${id}` : ''}`,
  );
}
