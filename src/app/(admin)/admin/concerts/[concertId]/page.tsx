import { redirect } from 'next/navigation';

/** A concert opens on its overview (spec/admin.md §14.1). */
export default async function ConcertIndexPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/overview`);
}
