'use client';

import * as React from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { RunReport } from '@/lib/commands/runner';
import { readRunAction } from './actions';
import { RunReportView } from './run-report';

/**
 * One command run's report, read back later (spec/v3.md §23.1: "the run is kept
 * and readable from the Activity log"). A run still `RUNNING` shows its
 * progress so far; the dialog does not work it — only the dialog that started
 * it, or the scheduler tick, does.
 */
export function RunDialog({
  concertId,
  runId,
  onClose,
}: {
  concertId: number;
  runId: number | null;
  onClose: () => void;
}) {
  // Keyed by the run it answers, so a stale result is never shown for another
  // run and nothing has to be reset when `runId` changes.
  const [result, setResult] = React.useState<
    { runId: number; report: RunReport | null; error: string | null } | null
  >(null);

  React.useEffect(() => {
    if (runId === null) return;
    let live = true;
    void readRunAction(concertId, runId).then((next) => {
      if (!live) return;
      setResult(
        next.ok
          ? { runId, report: next.value, error: null }
          : { runId, report: null, error: next.error },
      );
    });
    return () => {
      live = false;
    };
  }, [concertId, runId]);

  const current = result && result.runId === runId ? result : null;
  const report = current?.report ?? null;
  const error = current?.error ?? null;

  return (
    <Dialog open={runId !== null} onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(85dvh,48rem)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {report ? (
              <span className="font-mono text-sm">{report.command}</span>
            ) : (
              `Run #${runId ?? ''}`
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {error ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : report ? (
            <RunReportView report={report} />
          ) : (
            <div className="flex flex-col gap-3" aria-busy>
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0">
          {report && (
            <Button
              variant="outline"
              render={<Link href={`/admin/concerts/${concertId}/activity?run=${report.id}`} />}
              nativeButton={false}
              onClick={onClose}
            >
              Changes it made
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
