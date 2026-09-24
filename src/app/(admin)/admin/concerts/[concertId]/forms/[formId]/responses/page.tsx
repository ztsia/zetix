import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FormCard } from '@/components/forms/form-surface';
import { getForm, getResponses, isResponseSortKey } from '../../queries';
import { ResponsesTable } from './responses-table';
import { responseRow } from './rows';
import { SchemaExportButton } from './schema-export-button';

export const metadata: Metadata = { title: 'Responses' };

/**
 * `/admin/concerts/{id}/forms/{formId}/responses` (spec/v2.md §8.5).
 *
 * Table state lives in the URL so the server can answer from it and a
 * narrowed-down view is a shareable link — the same shape as `/admin/concerts`,
 * which is the reference implementation for server mode.
 */
export default async function ResponsesPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string; formId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { concertId: rawConcert, formId: rawForm } = await params;
  const concertId = Number(rawConcert);
  const formId = Number(rawForm);
  if (!Number.isInteger(concertId) || !Number.isInteger(formId)) notFound();

  const form = await getForm(concertId, formId);
  if (!form) notFound();

  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

  const pageIndex = Math.max(0, Number(one(query.page) ?? 0) || 0);
  const pageSize = [10, 25, 50, 100].includes(Number(one(query.size)))
    ? Number(one(query.size))
    : 25;
  const sortParam = one(query.sort) ?? 'submittedAt';
  const sort = isResponseSortKey(sortParam) ? sortParam : 'submittedAt';
  const desc = one(query.dir) === 'desc' || one(query.dir) === undefined;
  const search = one(query.q) ?? '';

  const { rows, rowCount } = await getResponses(formId, {
    pageIndex,
    pageSize,
    sort,
    desc,
    search,
  });

  const basePath = `/admin/concerts/${concertId}/forms/${formId}/responses`;
  const zone = form.timeZone ?? 'UTC';

  return (
    // One white card on the form canvas, as Google Forms' Responses tab is.
    <FormCard className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg">
            {form.responses === 1 ? '1 response' : `${form.responses} responses`}
          </h2>
          <p className="text-muted-foreground text-sm">
            What people submitted, as they submitted it. Seats granted are on the{' '}
            <Link
              href={`/admin/concerts/${concertId}/registrations`}
              className="underline underline-offset-4"
            >
              registrations
            </Link>{' '}
            screen — a form asks, the allocation engine decides.
          </p>
        </div>
        <SchemaExportButton concertId={concertId} formId={formId} count={form.responses} />
      </div>

      {form.kind === 'FEEDBACK' && (
        <Alert>
          <AlertTitle>Feedback answers are not listed here</AlertTitle>
          <AlertDescription>
            A feedback response is one attendee&rsquo;s, and is stored against that
            attendee rather than against a registration. The export above reads them and
            writes one row per attendee; this table lists registration responses only.
          </AlertDescription>
        </Alert>
      )}

      <ResponsesTable
        rows={rows.map((row) => responseRow(row, zone))}
        rowCount={rowCount}
        pageIndex={pageIndex}
        pageSize={pageSize}
        sorting={[{ id: sort, desc }]}
        search={search}
        basePath={basePath}
        timeZone={zone}
      />
    </FormCard>
  );
}
