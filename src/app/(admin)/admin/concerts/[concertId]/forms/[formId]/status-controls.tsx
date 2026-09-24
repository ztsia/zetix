'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CopyPlus, Lock, Play } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ActionDialog } from '../../../action-dialog';
import type { FormState } from '../../../form-state';
import { setFormStatusAction, startNewRoundAction } from '../actions';
import type { FormStatus } from '../queries';

/**
 * Publishing, closing, and starting the next round — the right-hand end of the
 * form's top bar, where Google Forms keeps its Publish button.
 *
 * **`open` is controlled on the confirm dialog.** `AlertDialogAction` is a plain
 * `Button` rather than a `Close`, so it does not dismiss its own dialog — every
 * other confirm in this console currently leaves a modal standing over an inert
 * shell. Fixing that properly means editing the shared component, which is its
 * own PR; not inheriting the bug here costs one `useState`.
 */

export function StatusControls({
  concertId,
  formId,
  status,
  responses,
  title,
}: {
  concertId: number;
  formId: number;
  status: FormStatus;
  responses: number;
  title: string;
}) {
  const router = useRouter();
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function setStatus(next: FormStatus) {
    setError(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('status', next);
      const result = await setFormStatusAction(concertId, formId, { error: null }, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirmClose(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <NewRoundDialog
          concertId={concertId}
          formId={formId}
          title={title}
          open={status === 'OPEN'}
          trigger={
            <Button size="sm" variant="ghost">
              <CopyPlus />
              New round
            </Button>
          }
        />

        {/*
          Google Forms' "Publish", in the form's accent: the one action on this
          bar that changes what strangers can reach, so it is the one that
          stands out. Once open it becomes the quieter way back.
        */}
        {status !== 'OPEN' && (
          <Button
            size="sm"
            disabled={isPending}
            className="bg-form-accent text-form-accent-foreground hover:bg-form-accent/90"
            onClick={() => setStatus('OPEN')}
          >
            {isPending ? <Spinner /> : <Play />}
            {status === 'CLOSED' ? 'Reopen' : 'Publish'}
          </Button>
        )}

        {status === 'OPEN' && (
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => setConfirmClose(true)}
          >
            <Lock />
            Stop responses
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert" className="max-w-md">
          <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
            {error}
          </AlertTitle>
        </Alert>
      )}

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The form stops taking responses immediately.{' '}
              {responses > 0
                ? `Its ${responses} response${responses === 1 ? '' : 's'} and the seats they claimed are unaffected.`
                : 'It has taken no responses yet.'}{' '}
              You can reopen it, or start a new round from its questions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Keep it open</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={() => setStatus('CLOSED')}>
              {isPending && <Spinner />}
              Close the form
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * A second round is a **new form on the same segment**, never an edit of the
 * first (`domain.md` §5.1).
 *
 * This dialog exists to make that the obvious path. The alternative an admin
 * will otherwise take — reopen round 1 and change its questions — rewrites what
 * every answer round 1 already took was answering, which is exactly what
 * pinning the schema per response exists to prevent (§8.2.4).
 */
function NewRoundDialog({
  concertId,
  formId,
  title,
  open,
  trigger,
}: {
  concertId: number;
  formId: number;
  title: string;
  /** Whether the source form is currently open, so closing it can be offered. */
  open: boolean;
  trigger: ReactNode;
}) {
  const id = useId();
  const router = useRouter();

  const action = (formData: FormData): Promise<FormState> =>
    startNewRoundAction(concertId, formId, { error: null }, formData);

  return (
    <ActionDialog
      trigger={trigger}
      title="Start another round"
      description={`Copies the questions of “${title}” into a new draft form on the same segment. Responses, dates and limits stay with the round that took them.`}
      submitLabel="Create the round"
      pendingLabel="Creating…"
      action={action}
      onSuccess={(result) => {
        if (result.message) router.push(`/admin/concerts/${concertId}/forms/${result.message}`);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-round`}>Round</FieldLabel>
          <Input id={`${id}-round`} name="roundLabel" required autoFocus placeholder="Round 2" />
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-slug`}>Link</FieldLabel>
          <Input id={`${id}-slug`} name="slug" placeholder="Taken from the title and round" />
          <FieldDescription>
            A new round needs its own link — the old one keeps taking people to the round
            that closed.
          </FieldDescription>
        </Field>

        {open && (
          <Field orientation="horizontal">
            <Switch id={`${id}-close`} name="closeCurrent" defaultChecked />
            <FieldLabel htmlFor={`${id}-close`}>Close the current round</FieldLabel>
          </Field>
        )}
      </FieldGroup>
    </ActionDialog>
  );
}
