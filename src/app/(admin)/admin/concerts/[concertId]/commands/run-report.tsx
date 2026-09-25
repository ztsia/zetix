'use client';

import { CircleCheck, CircleSlash, CircleX, Loader } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { RunReport } from '@/lib/commands/runner';

/**
 * Phase 3 of a command (spec/v3.md §23.1): what happened to each row.
 *
 * Shown by the command dialog the moment a run returns, and again from the
 * Activity log for any run later. Rows that ran are summarised by count; rows
 * that were skipped or failed are listed with the reason, because those are the
 * ones someone has to do something about.
 *
 * `labels` names rows by what the preview called them. From the Activity log
 * there is no preview, so a row falls back to what its outcome recorded, and
 * then to its id — a permanently deleted row keeps only its id (§23.6).
 */
export function RunReportView({
  report,
  labels,
}: {
  report: RunReport;
  labels?: Map<number, string>;
}) {
  const finished = report.done + report.skipped + report.failed;
  const running = report.status === 'RUNNING';
  // Rows someone has to look at: every skip and failure, and any row that ran
  // but whose outcome carries a `note` — "came back waitlisted" is done, and is
  // still not what "done" would lead the admin to assume.
  const noteOf = (item: RunReport['items'][number]) => {
    const note = (item.outcome as { note?: unknown } | null)?.note;
    return typeof note === 'string' && note ? note : null;
  };
  const exceptions = report.items.filter(
    (item) => item.status === 'FAILED' || item.status === 'SKIPPED' || noteOf(item) !== null,
  );

  const labelOf = (item: RunReport['items'][number]) => {
    const fromPreview = labels?.get(item.entityId);
    if (fromPreview) return fromPreview;
    const outcome = item.outcome as { label?: unknown } | null;
    return typeof outcome?.label === 'string' ? outcome.label : `#${item.entityId}`;
  };

  return (
    <div className="flex flex-col gap-4">
      {running ? (
        <Progress value={report.total === 0 ? 0 : (finished / report.total) * 100}>
          <span className="text-sm">
            Working… {finished} of {report.total}
          </span>
        </Progress>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={report.status} />
        <Badge variant="secondary">
          <CircleCheck data-icon="inline-start" />
          {report.done} done
        </Badge>
        {report.skipped > 0 && (
          <Badge variant="outline">
            <CircleSlash data-icon="inline-start" />
            {report.skipped} skipped
          </Badge>
        )}
        {report.failed > 0 && (
          <Badge variant="destructive">
            <CircleX data-icon="inline-start" />
            {report.failed} failed
          </Badge>
        )}
      </div>

      {report.reason && (
        <p className="text-muted-foreground text-sm">
          Reason: <span className="text-foreground">{report.reason}</span>
        </p>
      )}

      {exceptions.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {exceptions.map((item) => (
            <li key={`${item.entityType}-${item.entityId}`} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="font-medium">{labelOf(item)}</span>
              <span
                className={
                  item.status === 'FAILED'
                    ? 'text-destructive'
                    : item.status === 'DONE'
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }
              >
                {item.status === 'FAILED'
                  ? (item.error ?? 'Failed.')
                  : item.status === 'DONE'
                    ? noteOf(item)
                    : String((item.outcome as { reason?: unknown } | null)?.reason ?? 'Skipped.')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: RunReport['status'] }) {
  switch (status) {
    case 'RUNNING':
      return (
        <Badge variant="outline">
          <Loader data-icon="inline-start" className="animate-spin" />
          Running
        </Badge>
      );
    case 'COMPLETED':
      return <Badge>Completed</Badge>;
    case 'CANCELLED':
      return <Badge variant="outline">Cancelled</Badge>;
    case 'FAILED':
      return <Badge variant="destructive">Failed</Badge>;
  }
}
