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
import { cn } from '@/lib/utils';
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
 * - **The body scrolls; the header and footer do not.** `DialogContent` is
 *   centred with `-translate-y-1/2` and sets no max-height, so a form taller
 *   than the viewport is clipped at *both* ends — and the centring means the
 *   cut-off top cannot be scrolled to either. The segment form is nine fields
 *   and measured 979px, putting Save out of reach on a 1280×720 laptop, which
 *   is a size this console explicitly targets (see the sidebar note in
 *   `admin/nav.ts`). Capping the shell and scrolling the middle fixes every
 *   dialog in this module at once.
 */
export function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  pendingLabel,
  submitVariant,
  action,
  onSuccess,
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
  /**
   * Called with the successful result, just before the dialog closes.
   *
   * Added by module `B`: several of its actions succeed while telling the admin
   * something they need — "3 seats confirmed, 1 waitlisted" — and a dialog that
   * closes on success throws that away, so a party the engine quietly waitlisted
   * reads as a clean success. Optional and additive, so no existing caller
   * changes (`modules.md` §4: extend the shared component rather than growing a
   * second one).
   */
  onSuccess?: (result: FormState) => void;
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
      onSuccess?.(result);
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

      <DialogContent
        className={cn(
          'flex max-h-[min(85dvh,44rem)] flex-col',
          className ?? 'sm:max-w-lg',
        )}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form action={submit} className="flex min-h-0 flex-col gap-6">
          {/* `min-h-0` on both the form and this: a flex child defaults to
              `min-height: auto`, which refuses to shrink below its content and
              would push the footer back off-screen however the shell is
              capped. */}
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{children}</div>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
                {error}
              </AlertTitle>
            </Alert>
          )}

          <DialogFooter className="shrink-0">
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
