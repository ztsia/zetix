import { redirect } from 'next/navigation';

/**
 * `/exports` — a placeholder since V1. Removed by spec/v3.md §29.1: every view
 * exports itself from its own table. Kept as a redirect for bookmarks.
 */
export default async function RetiredPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/audience`);
}
