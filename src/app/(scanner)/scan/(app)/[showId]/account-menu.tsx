"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeftRight, CircleUser, LogOut, Smartphone } from "lucide-react";
import { signOutOperator } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";

/**
 * The scanner's account menu, on every screen (spec/v3.md §32.2).
 *
 * Before this an operator rostered on one show — the common case — had no way
 * to sign out at all: the picker held the only button, and they are redirected
 * past it every time.
 *
 * **Signing out asks first only when admissions are still unsynced.** With an
 * empty queue it is one tap. With a queue, the dialog says what happens to
 * those rows: they stay on this phone, tagged with this operator, and are never
 * sent as somebody else's.
 */
export function AccountMenu({
  operatorName,
  canSwitchShows,
  unsynced,
  onPrepareSignOut,
}: {
  operatorName: string;
  canSwitchShows: boolean;
  /** This operator's admissions not yet on the server. */
  unsynced: number;
  /** Drains if it can and wipes the roster from the phone. */
  onPrepareSignOut: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const signOut = () =>
    startTransition(async () => {
      await onPrepareSignOut();
      await signOutOperator();
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              // 44px: the smallest target a thumb hits reliably in the dark.
              className="size-11"
              aria-label="Account and sign out"
            />
          }
        >
          {pending ? <Spinner /> : <CircleUser className="size-6" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <span className="text-muted-foreground block text-xs">
                Signed in as
              </span>
              <span className="text-foreground block truncate text-sm font-medium">
                {operatorName}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {canSwitchShows && (
              <DropdownMenuItem
                className="min-h-11"
                render={<Link href="/scan" />}
              >
                <ArrowLeftRight />
                Switch show
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="min-h-11"
              render={<Link href="/scan/diagnostics" />}
            >
              <Smartphone />
              Check this phone
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="min-h-11"
            disabled={pending}
            onClick={() => (unsynced > 0 ? setConfirming(true) : signOut())}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <LogOut />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {unsynced} admission{unsynced === 1 ? " hasn't" : "s haven't"}{" "}
              synced
            </AlertDialogTitle>
            <AlertDialogDescription>
              They stay on this phone under your name and send the next time you
              sign in here. Nobody else can send them for you. The roster is
              removed from the phone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">
              Stay signed in
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-11"
              disabled={pending}
              onClick={signOut}
            >
              {pending && <Spinner />}
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
