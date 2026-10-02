'use client';

import { useState } from 'react';
import { Ticket, UserCheck } from 'lucide-react';
import type { ManifestEntry } from '@/lib/checkin/manifest';
import type { ManifestIndex } from '@/lib/checkin/manifest';
import { admittedKeys, type LocalCheckIn } from '@/lib/checkin/evaluate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';

/**
 * Attendee detail, as a bottom sheet (spec/surfaces.md §15.4, ref.md §1.4).
 *
 * **A sheet and not a route change, and ref.md calls this the single most
 * valuable detail in that document.** The camera stays mounted behind the
 * portal, so dismissing this returns to a live viewfinder rather than to a
 * 1–3 second re-acquisition.
 *
 * It is also where the party control lives (§12.1). A family of four holds four
 * PDFs in one email and in practice the person at the front shows the first
 * while the other three walk in behind them — scan one and three people are
 * admitted but unrecorded, which makes the Stats tab wrong for the rest of the
 * night. One tap writes the other three.
 */
export function AttendeeSheet({
  entry,
  index,
  checkIns,
  open,
  onOpenChange,
  onAdmit,
}: {
  entry: ManifestEntry | null;
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdmit: (entries: ManifestEntry[], reason: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!entry) return null;

  const party = index.byRegistration.get(entry.registrationId) ?? [entry];
  const admittedSeats = admittedKeys(index, checkIns);
  const remaining = party.filter((m) => !admittedSeats.has(index.keyOf(m)) && m.status !== 'CANCELLED');

  const admit = async (entries: ManifestEntry[], reason: string | null) => {
    setBusy(true);
    try {
      await onAdmit(entries, reason);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent
        // The sheet must clear the home indicator on a notched iPhone. The
        // surface layout sets viewport-fit=cover, so this inset is real.
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <DrawerHeader>
          <DrawerTitle className="text-xl uppercase">{entry.name}</DrawerTitle>
          <DrawerDescription>
            {entry.playerName ? `Guest of ${entry.playerName}` : 'Public registration'}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            {entry.ticketCode && (
              <Badge variant="outline" className="font-mono">
                <Ticket className="size-3" />
                {entry.ticketCode}
              </Badge>
            )}
            <Badge variant={entry.status === 'CANCELLED' ? 'destructive' : 'secondary'}>
              {entry.status === 'CANCELLED' ? 'Cancelled — refer to desk' : entry.status}
            </Badge>
            {admittedSeats.has(index.keyOf(entry)) && (
              <Badge variant="secondary">
                <UserCheck className="size-3" />
                Checked in
              </Badge>
            )}
          </div>

          {party.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Party of {entry.partySize}
              </p>
              {party.map((member) => (
                <Item key={index.keyOf(member)} variant="muted" size="xs">
                  <ItemContent>
                    <ItemTitle className="text-sm">{member.name}</ItemTitle>
                    <ItemDescription>
                      {member.status === 'CANCELLED'
                        ? 'Cancelled'
                        : admittedSeats.has(index.keyOf(member))
                          ? 'Admitted'
                          : 'Not yet in'}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </div>
          )}
        </div>

        <DrawerFooter>
          {remaining.length > 0 && (
            <Button
              size="lg"
              className="h-14 text-base"
              disabled={busy}
              onClick={() =>
                admit(
                  remaining,
                  remaining.length > 1 ? 'Admitted with party at the door' : null,
                )
              }
            >
              {remaining.length === 1
                ? `Admit ${remaining[0].name.split(' ')[0]}`
                : `Admit remaining ${remaining.length}`}
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            className="h-14 text-base"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
