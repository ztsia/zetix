'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import type { Selection } from '@/lib/commands/selection';
import type { Preview, RunReport } from '@/lib/commands/runner';
import { cn } from '@/lib/utils';
import {
  cancelRunAction,
  continueRunAction,
  previewCommandAction,
  runCommandAction,
} from './actions';
import { RunReportView } from './run-report';

/**
 * Preview → run → report, for any command over any selection
 * (spec/v3.md §23.1, §23.3).
 *
 * Every bulk action in the console opens this, so it is where the promises of
 * §23 become visible:
 *
 * - **The preview is the server's**, fetched when the dialog opens: per-row
 *   skips with reasons, and the blast radius counted from real data. A filter
 *   selection says it is resolved again at run time, because it is.
 * - **The typed phrase appears only when the server says it is needed** —
 *   irreversible and above `admin.typed_confirm_above` — and names the count.
 * - **Every command takes an optional reason**, written to `audit_log.reason`.
 * - **A run that outlives one request keeps going while the dialog is open**
 *   (the console's own loop, §27.2), and continues from the scheduler tick if it
 *   is closed. Closing never cancels; Cancel does.
 */

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'preview'; preview: Preview }
  | { kind: 'running'; preview: Preview; report: RunReport | null }
  | { kind: 'report'; preview: Preview; report: RunReport };

/** How many preview rows are drawn. A render limit, not an operational value. */
const ROWS_SHOWN = 200;

export function CommandDialog({
  concertId,
  command,
  selection,
  params,
  trigger,
  onDone,
}: {
  concertId: number;
  /** A registered command name, e.g. `trash.restore.party`. */
  command: string;
  selection: Selection<unknown> | null;
  params?: unknown;
  trigger: React.ReactElement;
  /** After a run finishes and the dialog closes — clear the table's selection. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState<Stage>({ kind: 'loading' });
  const [reason, setReason] = React.useState('');
  const [phrase, setPhrase] = React.useState('');
  const [runError, setRunError] = React.useState<string | null>(null);
  const alive = React.useRef(false);

  const loadPreview = React.useCallback(async () => {
    if (!selection) return;
    setStage({ kind: 'loading' });
    setRunError(null);
    setPhrase('');
    const result = await previewCommandAction(command, { concertId, selection, params });
    if (!alive.current) return;
    setStage(result.ok ? { kind: 'preview', preview: result.value } : { kind: 'error', message: result.error });
  }, [command, concertId, selection, params]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    alive.current = next;
    if (next) {
      setReason('');
      void loadPreview();
    } else if (stage.kind === 'report' || stage.kind === 'running') {
      router.refresh();
      if (stage.kind === 'report') onDone?.();
    }
  }

  React.useEffect(() => () => {
    alive.current = false;
  }, []);

  /** Keep working a paused run while the dialog is open. */
  async function follow(preview: Preview, report: RunReport) {
    let current = report;
    while (current.status === 'RUNNING' && alive.current) {
      setStage({ kind: 'running', preview, report: current });
      const next = await continueRunAction(concertId, current.id);
      if (!next.ok) {
        setRunError(next.error);
        return;
      }
      current = next.value;
    }
    if (alive.current) setStage({ kind: 'report', preview, report: current });
  }

  async function run(preview: Preview) {
    if (!selection) return;
    setRunError(null);
    setStage({ kind: 'running', preview, report: null });
    const result = await runCommandAction(command, {
      concertId,
      selection,
      params,
      reason: reason.trim() || null,
      confirmPhrase: preview.confirmation.required ? phrase : null,
    });
    if (!result.ok) {
      setRunError(result.error);
      setStage({ kind: 'preview', preview });
      return;
    }
    await follow(preview, result.value);
  }

  async function cancel(preview: Preview, report: RunReport) {
    const result = await cancelRunAction(concertId, report.id);
    if (result.ok) setStage({ kind: 'report', preview, report: result.value });
    else setRunError(result.error);
  }

  const preview = stage.kind === 'loading' || stage.kind === 'error' ? null : stage.preview;
  const title = preview
    ? `${preview.verb} ${preview.runnable} ${preview.runnable === 1 ? preview.noun.one : preview.noun.many}`
    : 'Preparing…';
  const labels = React.useMemo(
    () => new Map(preview?.rows.map((row) => [row.id, row.label]) ?? []),
    [preview],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger} disabled={!selection} />
      <DialogContent className="flex max-h-[min(85dvh,48rem)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{stage.kind === 'report' ? 'Done' : title}</DialogTitle>
          {preview && stage.kind === 'preview' && (
            <DialogDescription>
              {preview.byFilter
                ? 'Everything matching your filters is re-checked when it runs, so rows that start or stop matching before then are included or left out.'
                : 'Each row is checked again as its turn comes, so anything already done is skipped.'}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {stage.kind === 'loading' && (
            <div className="flex flex-col gap-3 py-2" aria-busy>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          )}

          {stage.kind === 'error' && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Could not prepare this</AlertTitle>
              <AlertDescription>{stage.message}</AlertDescription>
            </Alert>
          )}

          {stage.kind === 'preview' && (
            <PreviewBody
              preview={stage.preview}
              reason={reason}
              onReason={setReason}
              phrase={phrase}
              onPhrase={setPhrase}
            />
          )}

          {stage.kind === 'running' &&
            (stage.report ? (
              <RunReportView report={stage.report} labels={labels} />
            ) : (
              <p className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
                <Spinner /> Starting…
              </p>
            ))}

          {stage.kind === 'report' && <RunReportView report={stage.report} labels={labels} />}

          {runError && (
            <Alert variant="destructive" className="mt-4">
              <TriangleAlert />
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="shrink-0">
          {stage.kind === 'preview' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant={stage.preview.irreversible ? 'destructive' : 'default'}
                disabled={
                  stage.preview.runnable === 0 ||
                  (stage.preview.confirmation.required &&
                    normalise(phrase) !== stage.preview.confirmation.phrase)
                }
                onClick={() => void run(stage.preview)}
              >
                {title}
              </Button>
            </>
          )}
          {stage.kind === 'running' && stage.report && (
            <Button variant="outline" onClick={() => void cancel(stage.preview, stage.report!)}>
              Stop the rest
            </Button>
          )}
          {(stage.kind === 'report' || stage.kind === 'error') && (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

function PreviewBody({
  preview,
  reason,
  onReason,
  phrase,
  onPhrase,
}: {
  preview: Preview;
  reason: string;
  onReason: (value: string) => void;
  phrase: string;
  onPhrase: (value: string) => void;
}) {
  const skippedTotal = preview.total - preview.runnable;
  return (
    <div className="flex flex-col gap-5 py-1">
      {preview.blastRadius.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="What this will do">
          {preview.blastRadius.map((line) => (
            <li
              key={line.text}
              className={cn(
                'flex items-start gap-2 text-sm',
                line.tone === 'danger' && 'text-destructive',
              )}
            >
              <Badge
                variant={line.tone === 'danger' ? 'destructive' : line.tone === 'warning' ? 'outline' : 'secondary'}
                className="mt-0.5 tabular-nums"
              >
                {line.count}
              </Badge>
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}

      {skippedTotal > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">
            {skippedTotal} will be skipped
          </p>
          <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
            {preview.skipped.map((group) => (
              <li key={group.reason}>
                <span className="text-foreground tabular-nums">{group.count}</span> — {group.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.runnable === 0 && (
        <Alert>
          <AlertDescription>Nothing in this selection can be acted on.</AlertDescription>
        </Alert>
      )}

      <Collapsible>
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" className="-ml-2 self-start">
              <ChevronDown data-icon="inline-start" />
              Show each row
            </Button>
          }
        />
        <CollapsibleContent>
          <ul className="divide-y rounded-lg border text-sm">
            {preview.rows.slice(0, ROWS_SHOWN).map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{row.label}</span>
                  {row.detail && (
                    <span className="text-muted-foreground truncate">{row.detail}</span>
                  )}
                </span>
                {row.skip && (
                  <Badge variant="outline" className="shrink-0" title={row.skip}>
                    Skipped
                  </Badge>
                )}
              </li>
            ))}
            {preview.rows.length > ROWS_SHOWN && (
              <li className="text-muted-foreground px-3 py-2">
                and {preview.rows.length - ROWS_SHOWN} more
              </li>
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {preview.runnable > 0 && (
        <Field>
          <FieldLabel htmlFor="command-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="command-reason"
            value={reason}
            onChange={(event) => onReason(event.target.value)}
            placeholder="Kept in the Activity log with every change this makes."
            rows={2}
          />
        </Field>
      )}

      {preview.runnable > 0 && preview.confirmation.required && preview.confirmation.phrase && (
        <Field>
          <FieldLabel htmlFor="command-phrase">
            Type <span className="bg-muted rounded px-1 font-mono">{preview.confirmation.phrase}</span> to confirm
          </FieldLabel>
          <Input
            id="command-phrase"
            value={phrase}
            onChange={(event) => onPhrase(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            This cannot be undone, and it touches more than{' '}
            {preview.confirmation.threshold ?? 'the set number of'} rows.
          </FieldDescription>
        </Field>
      )}
    </div>
  );
}
