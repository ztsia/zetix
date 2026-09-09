'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, KeyRound, MoreHorizontal, ShieldCheck, ShieldOff } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  regenerateAccessCodeAction,
  setOperatorActiveAction,
  setShowAssignmentsAction,
} from './actions';
import type { IssuedCode } from './form-state';
import type { OperatorRow, ShowOption } from './operators-screen';

/**
 * Per-row assignment, code rotation and deactivation (spec/admin.md §14.3).
 *
 * Its own component because each control needs hooks and a column definition is
 * built inside a `useMemo`. It follows `ConcertRowActions`: destructive or
 * irreversible steps go through an `AlertDialog`, and the dialog is closed by
 * the *result* rather than by the click, so an error stays on screen instead of
 * disappearing with the dialog that would have shown it.
 */
export function OperatorRowActions({
  concertId,
  operator,
  shows,
  onIssued,
}: {
  concertId: number;
  operator: OperatorRow;
  shows: ShowOption[];
  onIssued: (issued: IssuedCode) => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function resetCode() {
    setError(null);
    startTransition(async () => {
      const result = await regenerateAccessCodeAction(operator.id, concertId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setResetting(false);
      // Shown once and never recoverable, so it is handed up before anything
      // else happens — including the refresh.
      if (result.issued) onIssued(result.issued);
      router.refresh();
    });
  }

  function toggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setOperatorActiveAction(operator.id, !operator.isActive, concertId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setTogglingActive(false);
      router.refresh();
    });
  }

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${operator.displayName}`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setAssigning(true)}>
            <CalendarCheck />
            Assign shows
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setResetting(true)}>
            <KeyRound />
            Issue a new code
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTogglingActive(true)}>
            {operator.isActive ? <ShieldOff /> : <ShieldCheck />}
            {operator.isActive ? 'Deactivate' : 'Reactivate'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open, so the grid initialises from the saved
          assignments every time. Cancelling an edit and reopening then shows
          what is actually stored rather than the abandoned attempt — without an
          effect that writes state back on each open. */}
      {assigning && (
        <AssignShowsDialog
          onOpenChange={setAssigning}
          concertId={concertId}
          operator={operator}
          shows={shows}
        />
      )}

      {/* Rotation invalidates the code the usher is currently holding, so it is
          confirmed rather than fired straight from the menu. */}
      <AlertDialog open={resetting} onOpenChange={setResetting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issue a new code for {operator.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their current code stops working immediately and you will have to pass the new one
              on. A device they are already signed in on stays signed in — deactivate them
              instead if you need to cut access now.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              nativeButton
              onClick={(event) => {
                event.preventDefault();
                resetCode();
              }}
              disabled={isPending}
            >
              {isPending && <Spinner />}
              Issue a new code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={togglingActive} onOpenChange={setTogglingActive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {operator.isActive
                ? `Deactivate ${operator.displayName}?`
                : `Reactivate ${operator.displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {operator.isActive
                ? 'They stop being able to scan on their next request, including on a phone ' +
                  'that is currently offline — its queued scans are refused when it syncs. ' +
                  'Their assignments and the scans they already recorded are kept.'
                : 'They can sign in and scan again with their existing code.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              nativeButton
              onClick={(event) => {
                event.preventDefault();
                toggleActive();
              }}
              disabled={isPending}
            >
              {isPending && <Spinner />}
              {operator.isActive ? 'Deactivate' : 'Reactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The assignment grid (spec/admin.md §14.3: "a checkbox grid of shows per
 * operator, editable at any time").
 */
function AssignShowsDialog({
  onOpenChange,
  concertId,
  operator,
  shows,
}: {
  onOpenChange: (open: boolean) => void;
  concertId: number;
  operator: OperatorRow;
  shows: ShowOption[];
}) {
  const [selected, setSelected] = useState<number[]>(operator.assignedShowIds);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setShowAssignmentsAction(operator.id, concertId, selected);
      if (result.error) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Shows for {operator.displayName}</DialogTitle>
          <DialogDescription>
            They can scan only the shows ticked here. Revoking one takes effect immediately, and
            a phone that is offline has its queued scans refused when it next syncs.
          </DialogDescription>
        </DialogHeader>

        {shows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            This concert has no shows yet, so there is nothing to assign. Add a show first.
          </p>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            {shows.map((show) => {
              const id = `assign-${operator.id}-${show.id}`;
              return (
                <div key={show.id} className="flex items-center gap-3">
                  <Checkbox
                    id={id}
                    checked={selected.includes(show.id)}
                    onCheckedChange={(checked: boolean) =>
                      setSelected((current) =>
                        checked
                          ? [...new Set([...current, show.id])]
                          : current.filter((value) => value !== show.id),
                      )
                    }
                  />
                  <Label htmlFor={id} className="font-normal">
                    {show.name}
                  </Label>
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
          </Alert>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={isPending || shows.length === 0}>
            {isPending && <Spinner />}
            Save assignments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
