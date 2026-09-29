import { redirect } from 'next/navigation';

/**
 * `/overview` — V1's at-a-glance screen. Retired by Home (spec/v3.md §29.2),
 * which carries its configuration gaps in the setup checklist and its
 * capacity in the funnel. Kept as a redirect for bookmarks.
 */
export default async function RetiredPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/home`);
}
