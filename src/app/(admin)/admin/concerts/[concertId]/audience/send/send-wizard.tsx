'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useCanEdit } from '@/components/auth/role';
import type { AudienceFilter } from '@/lib/audience/filter';
import type { Preview, RunReport } from '@/lib/commands/runner';
import type { Selection } from '@/lib/commands/selection';
import type { AddressCheckSummary, EmailPreview, WizardSetup } from '@/lib/delivery/wizard';
import { cn } from '@/lib/utils';
import { useBlastQueue } from '../../../../blast-queue';
import { continueRunAction, previewCommandAction, runCommandAction } from '../../commands/actions';
import { RunReportView } from '../../commands/run-report';
import { emailPreviewAction, sendWizardSetupAction } from './actions';

/**
 * **Send tickets**, as the four-step wizard of spec/v3.md §24.1 — Who, Ticket
 * design, Email, Send — over any Audience selection.
 *
 * It is one command (`delivery.send_tickets`, or `delivery.resend`) and this is
 * its dialog: every step edits the command's params, and every count shown is
 * the server's preview of those params, so what the admin confirms is what
 * runs. It replaces V1's prepare → review → confirm → send, and it is where
 * decision 23's review happens (decision 48): the run queues messages due now,
 * and the shell's queue sends them.
 *
 * A one-party resend from the record may skip steps 2–3 unless
 * `delivery.review_single_party` says otherwise (`reviewOptional`).
 */

type Params = {
  designs: Record<string, number>;
  templates: Record<string, string>;
  wording: Record<string, { subject: string; bodyMd: string }>;
};

const EMPTY: Params = { designs: {}, templates: {}, wording: {} };

type Step = 'who' | 'design' | 'email' | 'send';
const STEPS: { id: Step; label: string }[] = [
  { id: 'who', label: 'Who' },
  { id: 'design', label: 'Ticket design' },
  { id: 'email', label: 'Email' },
  { id: 'send', label: 'Send' },
];

type Setup = WizardSetup & { parties: number; addresses: AddressCheckSummary };

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  | { kind: 'running'; report: RunReport | null }
  | { kind: 'report'; report: RunReport };

export function SendWizard({
  concertId,
  command,
  selection,
  reviewOptional = false,
  onClosed,
  onDone,
}: {
  concertId: number;
  command: 'delivery.send_tickets' | 'delivery.resend';
  selection: Selection<AudienceFilter>;
  /** Steps 2–3 may be skipped: a one-party resend when `delivery.review_single_party` is off. */
  reviewOptional?: boolean;
  onClosed?: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const canEdit = useCanEdit();
  const queue = useBlastQueue();
  const [open, setOpen] = React.useState(true);
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });
  const [step, setStep] = React.useState<Step>('who');
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [params, setParams] = React.useState<Params>(EMPTY);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [runError, setRunError] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadPreview = React.useCallback(
    async (next: Params) => {
      setPreviewing(true);
      try {
        const result = await previewCommandAction(command, { concertId, selection, params: next });
        if (!alive.current) return;
        if (result.ok) setPreview(result.value);
        else setPhase({ kind: 'error', message: result.error });
      } catch (error) {
        if (alive.current) setPhase({ kind: 'error', message: thrownMessage(error) });
      } finally {
        if (alive.current) setPreviewing(false);
      }
    },
    [command, concertId, selection],
  );

  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const result = await sendWizardSetupAction(concertId, selection);
        if (!alive.current) return;
        if (!result.ok) {
          setPhase({ kind: 'error', message: result.error });
          return;
        }
        setSetup(result.value);
        // The address checks above may have flagged someone: the preview is
        // asked after them, so it skips those parties with the reason.
        await loadPreview(EMPTY);
        if (alive.current) setPhase((p) => (p.kind === 'loading' ? { kind: 'ready' } : p));
      } catch (error) {
        if (alive.current) setPhase({ kind: 'error', message: thrownMessage(error) });
      }
    })();
  }, [concertId, selection, loadPreview]);

  function update(next: Params) {
    setParams(next);
    void loadPreview(next);
  }

  function close() {
    setOpen(false);
    if (phase.kind === 'report' || phase.kind === 'running') {
      router.refresh();
      if (phase.kind === 'report') onDone?.();
    }
    onClosed?.();
  }

  async function follow(report: RunReport) {
    let current = report;
    while (current.status === 'RUNNING' && alive.current) {
      setPhase({ kind: 'running', report: current });
      const next = await continueRunAction(concertId, current.id);
      if (!next.ok) {
        setRunError(next.error);
        return;
      }
      current = next.value;
    }
    if (!alive.current) return;
    setPhase({ kind: 'report', report: current });
    // The run queued the messages; the shell's queue sends them now, and keeps
    // the banner honest if the tab closes halfway (§11.2.1).
    if (current.done > 0) queue.start();
  }

  async function run() {
    setRunError(null);
    setPhase({ kind: 'running', report: null });
    try {
      const result = await runCommandAction(command, {
        concertId,
        selection,
        params,
        reason: reason.trim() || null,
      });
      if (!result.ok) {
        setRunError(result.error);
        setPhase({ kind: 'ready' });
        return;
      }
      await follow(result.value);
    } catch (error) {
      setRunError(thrownMessage(error));
      setPhase({ kind: 'ready' });
    }
  }

  if (!canEdit) return null;

  const labels = new Map(preview?.rows.map((row) => [row.id, row.label]) ?? []);
  const index = STEPS.findIndex((s) => s.id === step);
  const resend = command === 'delivery.resend';
  const title = resend ? 'Resend tickets' : 'Send tickets';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent className="flex max-h-[min(90dvh,56rem)] flex-col sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{phase.kind === 'report' ? 'Done' : title}</DialogTitle>
          {(phase.kind === 'ready' || phase.kind === 'loading') && (
            <DialogDescription render={<div />}>
              <ol className="mt-1 flex flex-wrap items-center gap-1.5" aria-label="Steps">
                {STEPS.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-1.5">
                    <Badge
                      variant={s.id === step ? 'default' : i < index ? 'secondary' : 'outline'}
                      aria-current={s.id === step ? 'step' : undefined}
                    >
                      {i < index ? <Check data-icon="inline-start" /> : null}
                      {i + 1}. {s.label}
                    </Badge>
                  </li>
                ))}
              </ol>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {phase.kind === 'loading' && (
            <div className="flex flex-col gap-3 py-2" aria-busy>
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner /> Checking addresses and working out who will be sent…
              </p>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          )}

          {phase.kind === 'error' && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Could not prepare this</AlertTitle>
              <AlertDescription>{phase.message}</AlertDescription>
            </Alert>
          )}

          {phase.kind === 'ready' && setup && preview && (
            <>
              {step === 'who' && <WhoStep setup={setup} preview={preview} resend={resend} />}
              {step === 'design' && (
                <DesignStep concertId={concertId} setup={setup} params={params} onChange={update} />
              )}
              {step === 'email' && (
                <EmailStep concertId={concertId} setup={setup} params={params} onChange={update} />
              )}
              {step === 'send' && (
                <SendStep setup={setup} preview={preview} params={params} reason={reason} onReason={setReason} />
              )}
            </>
          )}

          {phase.kind === 'running' &&
            (phase.report ? (
              <RunReportView report={phase.report} labels={labels} />
            ) : (
              <p className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
                <Spinner /> Issuing tickets and queueing messages…
              </p>
            ))}

          {phase.kind === 'report' && (
            <div className="flex flex-col gap-4">
              <RunReportView report={phase.report} labels={labels} />
              {phase.report.done > 0 && (
                <Alert>
                  <AlertDescription>
                    The messages are queued and sending now. The banner at the top shows their progress; failures
                    land in Send failed.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {runError && (
            <Alert variant="destructive" className="mt-4">
              <TriangleAlert />
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="shrink-0">
          {phase.kind === 'ready' && preview && (
            <>
              {index > 0 ? (
                <Button variant="outline" onClick={() => setStep(STEPS[index - 1].id)}>
                  Back
                </Button>
              ) : (
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
              )}
              {step === 'who' && reviewOptional && (
                <Button variant="outline" disabled={preview.runnable === 0} onClick={() => setStep('send')}>
                  Skip to Send
                </Button>
              )}
              {step !== 'send' ? (
                <Button disabled={preview.runnable === 0} onClick={() => setStep(STEPS[index + 1].id)}>
                  Next
                </Button>
              ) : (
                <Button disabled={preview.runnable === 0 || previewing} onClick={() => void run()}>
                  {previewing ? <Spinner data-icon="inline-start" /> : null}
                  {resend ? 'Resend to' : 'Send to'} {preview.runnable}{' '}
                  {preview.runnable === 1 ? 'party' : 'parties'}
                </Button>
              )}
            </>
          )}
          {(phase.kind === 'report' || phase.kind === 'error') && <Button onClick={close}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 1. Who
// ---------------------------------------------------------------------------

function WhoStep({ setup, preview, resend }: { setup: Setup; preview: Preview; resend: boolean }) {
  const skipped = preview.total - preview.runnable;
  const { addresses } = setup;
  return (
    <div className="flex flex-col gap-5 py-1">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">{preview.runnable}</span>{' '}
        of {preview.total} {preview.total === 1 ? 'party' : 'parties'} will be {resend ? 'sent their tickets again' : 'sent their tickets'}.
        {preview.byFilter && (
          <span className="text-muted-foreground">
            {' '}
            Everything matching your filters is checked again when it runs.
          </span>
        )}
      </p>

      <BlastLines preview={preview} />

      {addresses.checked + addresses.left > 0 && (
        <p className="text-muted-foreground text-sm">
          Checked {addresses.checked} address{addresses.checked === 1 ? '' : 'es'} never checked before
          {addresses.flagged > 0
            ? `; ${addresses.flagged} ${addresses.flagged === 1 ? 'looks' : 'look'} wrong and ${addresses.flagged === 1 ? 'is' : 'are'} skipped below`
            : ''}
          .
          {addresses.left > 0
            ? ` ${addresses.left} could not be checked in time and are sent as they are; they are checked the next time this opens.`
            : ''}
        </p>
      )}

      {skipped > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{skipped} will be skipped</p>
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
          <AlertDescription>Nobody in this selection can be sent tickets right now.</AlertDescription>
        </Alert>
      )}

      <Rows preview={preview} />
    </div>
  );
}

function BlastLines({ preview }: { preview: Preview }) {
  if (preview.blastRadius.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="What this will do">
      {preview.blastRadius.map((line) => (
        <li key={line.text} className={cn('flex items-start gap-2 text-sm', line.tone === 'danger' && 'text-destructive')}>
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
  );
}

/** A render limit on the per-party list, not an operational value. */
const ROWS_SHOWN = 200;

function Rows({ preview }: { preview: Preview }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="sm" className="-ml-2 self-start">
            <ChevronDown data-icon="inline-start" />
            Show each party
          </Button>
        }
      />
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col divide-y rounded-lg border text-sm">
          {preview.rows.slice(0, ROWS_SHOWN).map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className={cn('min-w-0 truncate', row.skip && 'text-muted-foreground line-through')}>
                {row.label}
              </span>
              <span className="text-muted-foreground shrink-0 text-right text-xs">
                {row.skip ?? row.detail ?? 'Will be sent'}
              </span>
            </li>
          ))}
        </ul>
        {preview.rows.length > ROWS_SHOWN && (
          <p className="text-muted-foreground mt-2 text-xs">
            And {preview.rows.length - ROWS_SHOWN} more.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// 2. Ticket design
// ---------------------------------------------------------------------------

function DesignStep({
  concertId,
  setup,
  params,
  onChange,
}: {
  concertId: number;
  setup: Setup;
  params: Params;
  onChange: (next: Params) => void;
}) {
  if (setup.designs.length === 0) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>No ticket design yet</AlertTitle>
        <AlertDescription>Open Ticket designs once to create the concert’s default, then come back.</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-6 py-1">
      <p className="text-muted-foreground text-sm">
        Each segment uses its default design. Choosing another here pins it for these parties’ tickets that
        have not been delivered yet; tickets already delivered keep the design they were sent with.
      </p>
      {setup.segments.map((segment) => (
        <SegmentDesign
          key={segment.id}
          concertId={concertId}
          segment={segment}
          designs={setup.designs}
          value={params.designs[String(segment.id)] ?? segment.defaultDesignId}
          onChange={(designId) => {
            const designs = { ...params.designs };
            if (designId === segment.defaultDesignId || designId === null) delete designs[String(segment.id)];
            else designs[String(segment.id)] = designId;
            onChange({ ...params, designs });
          }}
        />
      ))}
    </div>
  );
}

function SegmentDesign({
  concertId,
  segment,
  designs,
  value,
  onChange,
}: {
  concertId: number;
  segment: Setup['segments'][number];
  designs: Setup['designs'];
  value: number | null;
  onChange: (designId: number | null) => void;
}) {
  const id = React.useId();
  const src =
    value === null
      ? null
      : `/api/tickets/design-preview?${new URLSearchParams({
          concertId: String(concertId),
          designId: String(value),
          ...(segment.longest ? { attendeeId: String(segment.longest.attendeeId) } : {}),
        })}`;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-sm font-medium">
        {segment.label}{' '}
        <span className="text-muted-foreground font-normal">
          · {segment.parties} {segment.parties === 1 ? 'party' : 'parties'}
        </span>
      </h3>
      <Field>
        <FieldLabel htmlFor={id}>Design</FieldLabel>
        <NativeSelect
          id={id}
          className="w-full"
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        >
          {value === null && <NativeSelectOption value="">No design</NativeSelectOption>}
          {designs.map((design) => (
            <NativeSelectOption key={design.id} value={design.id}>
              {design.label}
              {design.id === segment.defaultDesignId ? ' — this segment’s default' : ''}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          {segment.longest
            ? `Previewed with the longest name in the selection, “${segment.longest.name}”, so a name that overflows shows here.`
            : 'Previewed with sample data.'}
        </FieldDescription>
      </Field>
      {src && <PdfPreview key={src} src={src} label={`Ticket preview for ${segment.label}`} />}
    </section>
  );
}

/**
 * The rendered ticket, drawn with pdf.js rather than left to the browser's PDF
 * viewer, which not every browser has inline. The renderer reports what it had
 * to clip, and that is the point of previewing the longest name (§10.3).
 */
function PdfPreview({ src, label }: { src: string; label: string }) {
  const [state, setState] = React.useState<
    { kind: 'loading' } | { kind: 'ready'; url: string; clipped: string[] } | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  React.useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error('The preview could not be rendered.');
        const clipped = JSON.parse(response.headers.get('x-ticket-truncated') ?? '[]') as string[];
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
        const page = await document.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
        if (!blob) throw new Error('The preview rendered but produced no image.');
        objectUrl = URL.createObjectURL(blob);
        if (live) setState({ kind: 'ready', url: objectUrl, clipped });
      } catch (error) {
        if (live) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The preview failed.' });
      }
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (state.kind === 'loading') return <Skeleton className="h-56 w-full" />;
  if (state.kind === 'error') {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertDescription>
          {state.message}{' '}
          <a href={src} target="_blank" rel="noreferrer" className="underline">
            Open the PDF
          </a>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {state.clipped.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            Something did not fit and was cut short on this ticket. Widen the box in the design before sending.
          </AlertDescription>
        </Alert>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL of a canvas, not an asset to optimise */}
      <img src={state.url} alt={label} className="w-full rounded-lg border" />
      <a href={src} target="_blank" rel="noreferrer" className="text-muted-foreground self-end text-xs underline">
        Open the PDF
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Email
// ---------------------------------------------------------------------------

function EmailStep({
  concertId,
  setup,
  params,
  onChange,
}: {
  concertId: number;
  setup: Setup;
  params: Params;
  onChange: (next: Params) => void;
}) {
  return (
    <div className="flex flex-col gap-8 py-1">
      {setup.segments.map((segment) => (
        <SegmentEmail
          key={segment.id}
          concertId={concertId}
          segment={segment}
          setup={setup}
          params={params}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function SegmentEmail({
  concertId,
  segment,
  setup,
  params,
  onChange,
}: {
  concertId: number;
  segment: Setup['segments'][number];
  setup: Setup;
  params: Params;
  onChange: (next: Params) => void;
}) {
  const templateId = React.useId();
  const asId = React.useId();
  const editId = React.useId();
  const templateKey = params.templates[String(segment.id)] ?? segment.defaultTemplate;
  const template = setup.templates.find((t) => t.key === templateKey);
  const recipients = setup.recipients.filter((r) => r.segmentId === segment.id);
  const [as, setAs] = React.useState<number | null>(recipients[0]?.id ?? null);
  const own = params.wording[templateKey];
  // The editor's text is kept here while the admin types, and committed to the
  // params (and so to the preview) when a field loses focus. It starts again
  // from the params whenever the template or the switch changes.
  const draftKey = `${templateKey}:${own ? 'own' : 'library'}`;
  const [draft, setDraft] = React.useState(own ?? null);
  const [draftFor, setDraftFor] = React.useState(draftKey);
  if (draftFor !== draftKey) {
    setDraftFor(draftKey);
    setDraft(own ?? null);
  }

  // Each answer is kept with the request it answers, so a stale one is never
  // shown for the current choice and no reset is needed between them.
  const requestKey = JSON.stringify([as, templateKey, own ?? null]);
  const [rendered, setRendered] = React.useState<{ key: string; value: EmailPreview | { error: string } } | null>(
    null,
  );
  React.useEffect(() => {
    if (as === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void emailPreviewAction(concertId, as, templateKey, own ?? null).then((result) => {
        if (live) setRendered({ key: requestKey, value: result.ok ? result.value : { error: result.error } });
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [concertId, as, templateKey, own, requestKey]);
  const current = rendered?.key === requestKey ? rendered.value : null;

  function setTemplate(key: string) {
    const templates = { ...params.templates };
    if (key === segment.defaultTemplate) delete templates[String(segment.id)];
    else templates[String(segment.id)] = key;
    onChange({ ...params, templates });
  }

  function setWording(next: { subject: string; bodyMd: string } | null) {
    const wording = { ...params.wording };
    if (next) wording[templateKey] = next;
    else delete wording[templateKey];
    onChange({ ...params, wording });
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${templateId}-title`}>
      <h3 id={`${templateId}-title`} className="text-sm font-medium">
        {segment.label}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={templateId}>Template</FieldLabel>
          <NativeSelect
            id={templateId}
            className="w-full"
            value={templateKey}
            onChange={(event) => setTemplate(event.target.value)}
          >
            {setup.templates.map((t) => (
              <NativeSelectOption key={t.key} value={t.key}>
                {t.name}
                {t.key === segment.defaultTemplate ? ' — default' : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={asId}>Preview as</FieldLabel>
          <NativeSelect
            id={asId}
            className="w-full"
            value={as === null ? '' : String(as)}
            onChange={(event) => setAs(event.target.value ? Number(event.target.value) : null)}
          >
            {recipients.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <Field orientation="horizontal">
        <Switch
          id={editId}
          checked={own !== undefined}
          disabled={!template}
          onCheckedChange={(checked: boolean) =>
            setWording(checked && template ? { subject: template.subject, bodyMd: template.bodyMd } : null)
          }
        />
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor={editId}>Edit wording for this send</FieldLabel>
          <FieldDescription>
            Changes these messages only. The library template stays as it is.
          </FieldDescription>
        </div>
      </Field>

      {draft && (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <Field>
            <FieldLabel htmlFor={`${editId}-subject`}>Subject</FieldLabel>
            <Input
              id={`${editId}-subject`}
              value={draft.subject}
              maxLength={500}
              onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              onBlur={() => draft.subject.trim() && setWording(draft)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${editId}-body`}>Message (Markdown)</FieldLabel>
            <Textarea
              id={`${editId}-body`}
              value={draft.bodyMd}
              rows={10}
              className="font-mono text-xs"
              onChange={(event) => setDraft({ ...draft, bodyMd: event.target.value })}
              onBlur={() => draft.bodyMd.trim() && setWording(draft)}
            />
            <FieldDescription>Merge fields such as {'{{ ticket_links }}'} work as in the template.</FieldDescription>
          </Field>
        </div>
      )}

      {current === null && as !== null && <Skeleton className="h-64 w-full" />}
      {current && 'error' in current && (
        <Alert variant="destructive">
          <AlertDescription>{current.error}</AlertDescription>
        </Alert>
      )}
      {current && !('error' in current) && (
        <div className="flex flex-col gap-2">
          <div className="text-sm">
            <p>
              <span className="text-muted-foreground">To </span>
              {current.toEmail ?? 'no address'}
            </p>
            <p>
              <span className="text-muted-foreground">Subject </span>
              {current.subject}
            </p>
          </div>
          {current.unknown.length > 0 && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>
                The wording names {current.unknown.join(', ')}, which resolve to nothing and would be blank.
              </AlertDescription>
            </Alert>
          )}
          {current.unissued > 0 && (
            <p className="text-muted-foreground text-xs">
              {current.unissued} of this party’s tickets are issued when this runs, so their links appear in the
              message then, not in this preview.
            </p>
          )}
          <iframe
            srcDoc={current.html}
            sandbox=""
            title={`Email preview for ${segment.label}`}
            className="h-96 w-full rounded-lg border bg-white"
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4. Send
// ---------------------------------------------------------------------------

function SendStep({
  setup,
  preview,
  params,
  reason,
  onReason,
}: {
  setup: Setup;
  preview: Preview;
  params: Params;
  reason: string;
  onReason: (value: string) => void;
}) {
  const id = React.useId();
  const design = (segmentId: number) => {
    const chosen = params.designs[String(segmentId)];
    const segment = setup.segments.find((s) => s.id === segmentId)!;
    const designId = chosen ?? segment.defaultDesignId;
    return setup.designs.find((d) => d.id === designId)?.label ?? 'No design';
  };
  const template = (segmentId: number) => {
    const segment = setup.segments.find((s) => s.id === segmentId)!;
    const key = params.templates[String(segmentId)] ?? segment.defaultTemplate;
    return setup.templates.find((t) => t.key === key)?.name ?? key;
  };
  return (
    <div className="flex flex-col gap-5 py-1">
      <BlastLines preview={preview} />
      <ul className="flex flex-col gap-2 text-sm">
        {setup.segments.map((segment) => {
          const own = params.wording[params.templates[String(segment.id)] ?? segment.defaultTemplate];
          return (
            <li key={segment.id} className="rounded-lg border px-3 py-2">
              <p className="font-medium">{segment.label}</p>
              <p className="text-muted-foreground">
                {design(segment.id)} · {template(segment.id)}
                {own ? ' · wording edited for this send' : ''}
              </p>
            </li>
          );
        })}
      </ul>
      {preview.total - preview.runnable > 0 && (
        <p className="text-muted-foreground text-sm">
          {preview.total - preview.runnable} skipped, as the first step listed.
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={id}>Reason (optional)</FieldLabel>
        <Input id={id} value={reason} maxLength={2000} onChange={(event) => onReason(event.target.value)} />
        <FieldDescription>Kept in the Activity log with this send.</FieldDescription>
      </Field>
      <Rows preview={preview} />
    </div>
  );
}

function thrownMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The request did not go through. Reload the page and try again.';
}
