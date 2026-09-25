import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { ArrowLeft } from 'lucide-react';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { Button } from '@/components/ui/button';
import { requireRole } from '@/lib/auth/guards';
import { ensureConcertTemplates } from '@/lib/tickets/seed-templates';
import { listTemplates } from '@/lib/tickets/templates';
import { TemplateList } from './template-list';

export const metadata: Metadata = { title: 'Ticket templates' };

/**
 * `/admin/concerts/{id}/tickets/templates` — the templates a concert can print
 * from (spec/tickets.md §10.3).
 *
 * A sibling of module `D`'s tickets screen rather than a tab inside it: that one
 * is a table of four hundred attendees and this one a list of three designs, and
 * the only thing they share is the word "ticket".
 *
 * **Seeding is triggered here, and is why the screen is never empty.** Module
 * `D` seeds a concert's three defaults lazily, the first time something needs to
 * render for it (decision 10). Opening the editor is exactly such a moment: an
 * admin who came here to lay out their artwork should find three working designs
 * to start from, not an empty page and a note about lazy seeding.
 */
export default async function TicketTemplatesPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  await requireRole('ADMIN', 'VIEWER');

  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const [concert] = await getDb()
    .select({ id: concerts.id, name: concerts.name })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)))
    .limit(1);
  if (!concert) notFound();

  await ensureConcertTemplates(concertId);
  const templates = await listTemplates(concertId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Ticket templates</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            The design a ticket is printed with. Editing one that has already issued tickets
            saves a new version, so the PDF someone already holds never changes.
          </p>
        </div>
        <Button
          variant="outline"
          // A Button rendering an anchor is not a native <button>, and Base UI
          // logs an accessibility error on every load unless told so.
          nativeButton={false}
          render={<Link href={`/admin/concerts/${concertId}/tickets`} />}
        >
          <ArrowLeft />
          Back to tickets
        </Button>
      </div>

      <TemplateList concertId={concertId} templates={templates} />
    </div>
  );
}
