import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PREVIEW_PATH } from '@/lib/forms/preview-draft';
import { getForm } from '../queries';
import { CopyLinkButton } from './copy-link-button';
import { FormTabs } from './form-tabs';
import { StatusControls } from './status-controls';

/**
 * One form, in Google Forms' frame (spec/v2.md §8.2, spec/admin.md §14.1).
 *
 * A white bar across the top — back, the title, what state it is in, and the
 * actions that act on the whole form: preview, copy the link, publish — then
 * the Questions · Responses · Settings tabs, then the tinted canvas the tab's
 * content sits on. It is the screen everyone who has built a Google Form
 * already knows, and every round of this concert so far was built there.
 *
 * **A layout, so the frame survives moving between tabs.** Each tab is its own
 * route (`form-tabs.tsx` says why), and the bar is the same on all three.
 *
 * The frame bleeds to the edges of the console's padded column — the negative
 * margins undo the shell's `p-4 md:p-6` — because a canvas with a white border
 * round it reads as a card on a page rather than the page itself.
 */
export default async function FormLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ concertId: string; formId: string }>;
}) {
  const { concertId: rawConcert, formId: rawForm } = await params;
  const concertId = Number(rawConcert);
  const formId = Number(rawForm);
  if (!Number.isInteger(concertId) || !Number.isInteger(formId)) notFound();

  const form = await getForm(concertId, formId);
  if (!form) notFound();

  const basePath = `/admin/concerts/${concertId}/forms/${formId}`;

  return (
    <div className="bg-form-canvas -m-4 flex flex-1 flex-col md:-m-6">
      <header className="bg-background border-b">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 md:px-6">
          {/*
            Links, so a native `title` rather than `Tooltip`: wrapping a
            link-rendering `Button` in `TooltipTrigger` nests three `render`
            props, and from a server layout that hydrates with the wrong
            `data-slot`.
          */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="All forms"
            title="All forms"
            nativeButton={false}
            render={<Link href={`/admin/concerts/${concertId}/forms`} />}
          >
            <ArrowLeft />
          </Button>

          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-lg leading-7">
              <span className="truncate">{form.title}</span>
              {form.roundLabel && <Badge variant="outline">{form.roundLabel}</Badge>}
              <Badge variant={form.status === 'OPEN' ? 'default' : 'secondary'}>
                {form.status === 'OPEN' ? 'published' : form.status.toLowerCase()}
              </Badge>
            </h1>
            <p className="text-muted-foreground truncate text-xs">
              {form.showName}
              {form.segmentName ? ` · ${form.segmentName}` : ''} · /f/{form.slug} · version{' '}
              {form.schemaVersion}
            </p>
          </div>

          <div className="flex items-center gap-1">
            {/*
              Opens what is saved, plus any unsaved builder changes: the builder
              keeps its draft in browser storage while it has one, and the
              preview reads it (§8.2.2b). So this one button serves both.
            */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Preview"
              title="Preview"
              nativeButton={false}
              render={<a href={PREVIEW_PATH(formId)} target="_blank" rel="noopener" />}
            >
              <Eye />
            </Button>

            <CopyLinkButton slug={form.slug} live={form.status === 'OPEN'} />

            <StatusControls
              concertId={concertId}
              formId={formId}
              status={form.status}
              responses={form.responses}
              title={form.title}
            />
          </div>
        </div>

        <FormTabs basePath={basePath} responses={form.responses} />
      </header>

      <div className="flex flex-1 flex-col gap-4 px-3 py-4 md:px-6 md:py-6">{children}</div>
    </div>
  );
}
