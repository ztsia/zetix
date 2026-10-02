"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { signOutOperator } from "@/lib/auth/actions";
import { openCheckinStore } from "@/lib/checkin/store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * Sign out from a scanner screen that is not a show (the picker, the phone
 * check). Like the shell's account menu, it removes every roster from the
 * phone first and keeps unsynced admissions under the name of whoever made
 * them (spec/v3.md §32.2).
 */
export function ScannerSignOutButton({ className }: { className?: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const store = await openCheckinStore();
            await store.wipeForSignOut();
          } catch {
            // Storage refused: there is nothing on the phone to wipe.
          }
          await signOutOperator();
        })
      }
    >
      {pending ? <Spinner /> : <LogOut />}
      Sign out
    </Button>
  );
}
