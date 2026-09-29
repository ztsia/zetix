import { redirect } from 'next/navigation';

/** A concert opens on Home (spec/v3.md §29.1). */
export default async function ConcertIndexPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  redirect(`/admin/concerts/${concertId}/home`);
}
