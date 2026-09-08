'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, MoreHorizontal } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { setConcertArchivedAction } from './actions';

/**
 * Per-row archive and restore (spec/admin.md §14.1).
 *
 * Archiving is confirmed through an `AlertDialog` rather than fired straight
 * from the menu: it takes a concert out of the working list, and a mis-click on
 * a dense table is exactly what that component exists to prevent. Restoring is
 * not confirmed — it is the undo.
 *
 * Its own component because the cell needs hooks, and a column definition is a
 * module-level constant.
 */
export function ConcertRowActions({
  concertId,
  name,
  status,
}: {
  concertId: number;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const archived = status === 'ARCHIVED';

  function run(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setConcertArchivedAction(concertId, next);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    // The row itself navigates to the concert, so the menu must not: without
    // this every click on the trigger would also open the overview.
    <div onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={`Actions for ${name}`} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? (
            <DropdownMenuItem onClick={() => run(false)} disabled={isPending}>
              <ArchiveRestore />
              Restore as draft
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setConfirming(true)}>
              <Archive />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the working list but nothing is deleted — its registrations, tickets
              and scan log stay exactly as they are, and you can restore it at any time.
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
              // `AlertDialogAction` closes the dialog on click, which would hide
              // an error the action returns. Closing is driven by the result
              // instead.
              nativeButton
              onClick={(event) => {
                event.preventDefault();
                run(true);
              }}
              disabled={isPending}
            >
              {isPending && <Spinner />}
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
