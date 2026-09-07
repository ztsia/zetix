'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import type { FormState } from './form-state';

/**
 * A form in a dialog, wired to one of module `A`'s Server Actions.
 *
 * Every configuration form on this branch wants the same four behaviours, and
 * they are the easy ones to get subtly wrong three times over:
 *
 * - **The dialog closes on success and stays open on failure.** Closing on
 *   submit throws away a form the admin has just filled in, and several of these
 *   failures are worth correcting in place rather than retyping.
 * - **The error renders whole.** The database's guards raise sentences that name
 *   the numbers and the ways out (spec/allocation.md §7.4); truncating one
 *   removes the part that says what to do.
 * - **`router.refresh()` after a success**, so the server-rendered page behind
 *   the dialog reflects the write in the same interaction.
 * - **The action is awaited rather than driven through `useActionState`**,
 *   because the *result* is what decides whether to close.
 */
export function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  pendingLabel,
  submitVariant,
  action,
  children,
  className,
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  submitVariant?: 'default' | 'destructive';
  action: (formData: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        // A dialog reopened after a failure should not still be showing the
        // error from last time.
        if (!next) setError(null);
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />

      <DialogContent className={className ?? 'sm:max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-6">
          {children}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
                {error}
              </AlertTitle>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant={submitVariant} disabled={isPending}>
              {isPending && <Spinner />}
              {isPending ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
