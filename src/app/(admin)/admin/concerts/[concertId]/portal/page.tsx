import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/guards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BookletManager } from './booklet-manager';
import { PracticalInfoForm } from './practical-info-form';
import { loadPortalScreen } from './queries';

export const metadata: Metadata = { title: 'Portal' };

/**
 * `/admin/concerts/{id}/portal` — the admin half of `/t/{token}`
 * (spec/v2.md §13.3, spec/admin.md §14.1).
 *
 * **Unlock mode is not on this screen**, though the nav blurb once promised it.
 * `portal.unlock_mode` is a per-show value resolved through the cascade and the
 * Shows screen already edits it with a cascade hint beside it; a second control
 * here would either contradict that hint or silently write a different level.
 * What *is* here is everything that belongs to the concert: the booklet, and the
 * practical info.
 */
export default async function PortalPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  await requireAdmin();

  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const screen = await loadPortalScreen(concertId);
  if (!screen) notFound();

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Portal</h1>
        <p className="text-sm text-muted-foreground">
          What a ticket holder sees at their QR link once they have unlocked it. Unlock mode is set
          per show, on the Shows screen.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Programme booklet</CardTitle>
          <CardDescription>
            Visible only once published, so it can be uploaded early and released on the day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BookletManager
            concertId={concertId}
            booklets={screen.booklets}
            shows={screen.shows}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Practical info</CardTitle>
          <CardDescription>Parking, latecomers, the interval.</CardDescription>
        </CardHeader>
        <CardContent>
          <PracticalInfoForm concertId={concertId} value={screen.practicalInfoMd} />
        </CardContent>
      </Card>
    </div>
  );
}
