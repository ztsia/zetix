'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import type { FormState } from '../../form-state';
import { useCanEdit } from '@/components/auth/role';

/**
 * Confirmed removal of a show or a segment.
 *
 * The database refuses while confirmed seats remain, with a sentence saying how
 * many — deleting one would leave those people holding tickets to nothing. That
 * refusal is shown **inside the dialog**, which is why this cannot be a plain
 * `AlertDialogAction`: the default closes on click and would take the
 * explanation with it.
 */
export function DeleteButton({
  trigger,
  title,
  description,
  confirmLabel,
  action,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  action: () => Promise<FormState>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const canEdit = useCanEdit();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  // A delete is a mutation; a viewer is not offered one (spec/v3.md §28).
  if (!canEdit) return null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger render={trigger as React.ReactElement} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
              {error}
            </AlertTitle>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            nativeButton
            onClick={(event) => {
              event.preventDefault();
              run();
            }}
            disabled={isPending}
          >
            {isPending && <Spinner />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
