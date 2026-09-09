'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { revertCheckInAction } from './actions';

/**
 * Undo one scan (spec/checkin.md §12.4).
 *
 * Confirmed rather than fired straight from the row: it changes what the door's
 * own numbers say, and on a dense log a mis-click is easy. The optional reason
 * is recorded in `audit_log`, not on the row — `check_ins` is append-only and
 * carries what the *door* recorded, while why an admin undid it is an admin
 * fact (spec/README.md §2.4).
 *
 * The dialog is closed by the result, not by the click, so a refusal — someone
 * else reverted the same row a second earlier — stays on screen.
 */
export function RevertScanButton({
  checkInId,
  showId,
  concertId,
  attendeeName,
}: {
  checkInId: number;
  showId: number;
  concertId: number;
  attendeeName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function revert() {
    setError(null);
    startTransition(async () => {
      const result = await revertCheckInAction({
        checkInId,
        showId,
        concertId,
        reason: reason.trim() || null,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Revert the scan for ${attendeeName}`}
        onClick={() => setOpen(true)}
      >
        <RotateCcw />
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next: boolean) => {
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert the scan for {attendeeName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The row stays in the log, marked as reverted — nothing is deleted. They drop out of
              the checked-in count, and their ticket scans clean again at the door.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Field>
            <FieldLabel htmlFor={`revert-reason-${checkInId}`}>Reason (optional)</FieldLabel>
            <Input
              id={`revert-reason-${checkInId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="Scanned the wrong person"
            />
            <FieldDescription>Recorded in the audit log.</FieldDescription>
          </Field>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // Closing on click would hide a refusal this action can return.
              nativeButton
              onClick={(event) => {
                event.preventDefault();
                revert();
              }}
              disabled={isPending}
            >
              {isPending && <Spinner />}
              Revert scan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
