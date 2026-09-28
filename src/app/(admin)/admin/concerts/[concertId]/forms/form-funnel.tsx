import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FormFunnel } from '@/lib/intake/funnel';
import { CopyLinkButton } from './[formId]/copy-link-button';

/**
 * The funnel as one line — *12 responses → 10 parties → 8 approved → 5 sent*
 * (spec/v3.md §25.6). Each step past responses links to those parties in the
 * Audience.
 */
export function FunnelLine({ funnel }: { funnel: FormFunnel }) {
  if (funnel.kind === 'FEEDBACK') {
    return (
      <span className="tabular-nums">
        {funnel.responses} response{funnel.responses === 1 ? '' : 's'}
      </span>
    );
  }
  const steps = [
    [funnel.responses, funnel.responses === 1 ? 'response' : 'responses'],
    [funnel.parties, funnel.parties === 1 ? 'party' : 'parties'],
    [funnel.approved, 'approved'],
    [funnel.sent, 'sent'],
  ] as const;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {steps.map(([count, label], index) => (
        <span key={label} className="inline-flex items-center gap-1">
          {index > 0 && <ChevronRight className="text-muted-foreground size-3" aria-hidden />}
          <span className="tabular-nums">{count}</span> {label}
        </span>
      ))}
    </span>
  );
}

/**
 * A segment's forms, shown on its parent (spec/v3.md §25.6): title, state,
 * Copy link and the funnel.
 */
export function SegmentForms({
  concertId,
  forms,
  appUrl,
}: {
  concertId: number;
  forms: FormFunnel[];
  /** `APP_URL`, read on the server and handed down (it is not a public variable). */
  appUrl: string | null;
}) {
  if (forms.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No form yet.{' '}
        <Link className="underline underline-offset-4" href={`/admin/concerts/${concertId}/forms`}>
          Create one
        </Link>
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {forms.map((form) => (
        <li key={form.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Link
            className="font-medium underline-offset-4 hover:underline"
            href={`/admin/concerts/${concertId}/forms/${form.id}`}
          >
            {form.title}
          </Link>
          <Badge variant={form.status === 'OPEN' ? 'default' : 'outline'}>{form.status.toLowerCase()}</Badge>
          <span className="text-muted-foreground">
            <FunnelLine funnel={form} />
          </span>
          <CopyLinkButton slug={form.slug} live={form.status === 'OPEN'} appUrl={appUrl} />
        </li>
      ))}
    </ul>
  );
}
