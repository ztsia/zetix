import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth/guards';
import { previewOptions, previewTicketData } from '@/lib/tickets/preview';
import { loadTemplate, previewShows } from '@/lib/tickets/templates';
import { TemplateEditor } from './template-editor';

export const metadata: Metadata = { title: 'Edit ticket template' };

/**
 * `/admin/concerts/{id}/tickets/templates/{templateId}` — the canvas editor
 * (spec/tickets.md §10.3).
 *
 * A Server Component that does the loading and hands a Client Component the
 * finished picture: the template, the concert's shows, and the ticket data to
 * preview against. The editor itself owns no queries — everything it needs to
 * draw a ticket is resolved here, once, so dragging an element never touches the
 * database.
 *
 * **The template is loaded by `(concertId, templateId)`, not by id alone.** A
 * template id from another concert would otherwise open here and save into this
 * one.
 */
export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string; templateId: string }>;
  searchParams: Promise<{ show?: string; saved?: string }>;
}) {
  await requireAdmin();

  const { concertId: rawConcert, templateId: rawTemplate } = await params;
  const concertId = Number(rawConcert);
  const templateId = Number(rawTemplate);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();
  if (!Number.isInteger(templateId) || templateId <= 0) notFound();

  const template = await loadTemplate(concertId, templateId);
  if (!template) notFound();

  const showRows = await previewShows(concertId);
  const shows = showRows.map((row) => ({ id: Number(row.id), name: row.name }));

  const query = await searchParams;
  const requested = Number(query.show ?? 0);
  const showId =
    shows.find((show) => show.id === requested)?.id ?? shows[0]?.id ?? null;

  /**
   * A concert with no show yet still has to be editable — templates are often
   * laid out before the hall is booked. The preview then falls back to sample
   * data, and the PDF preview says why it cannot run.
   */
  const options = showId ? await previewOptions(concertId, showId) : [];
  const data = showId
    ? await previewTicketData({
        concertId,
        showId,
        subject: options[0]?.subject ?? 'SAMPLE',
        attendeeId: options[0]?.attendeeId ?? null,
      })
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{template.name}</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Place the attendee&apos;s name, the QR and anything else over your artwork. Each
            element moves and resizes on its own.
          </p>
        </div>
        <Button
          variant="outline"
          render={<Link href={`/admin/concerts/${concertId}/tickets/templates`} />}
        >
          <ArrowLeft />
          All templates
        </Button>
      </div>

      {data ? (
        <TemplateEditor
          concertId={concertId}
          template={template}
          shows={shows}
          showId={showId}
          previewOptions={options}
          previewData={data}
          // Bounded: it is reflected into an alert, and it arrives in a URL
          // anyone can hand an admin.
          savedMessage={query.saved?.slice(0, 200) ?? null}
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          This concert has no shows yet, so there is nothing to preview a ticket against. Add
          one under Shows and come back.
        </p>
      )}
    </div>
  );
}
