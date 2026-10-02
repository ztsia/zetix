'use client';

import { useState } from 'react';
import { CircleAlert, CloudOff } from 'lucide-react';
import type { QueuedScan } from '@/lib/checkin/store';
import type { ManifestIndex } from '@/lib/checkin/manifest';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { formatDoorTime } from './format';

/**
 * Where this phone's admissions are (spec/v3.md §32.2).
 *
 * "Waiting for signal", "syncing" and "refused" read differently, because they
 * ask different things of the usher: nothing, nothing, and "tell the desk". A
 * single "3 queued" for all three hid the one that needed action.
 *
 * Refused wins the badge when there is any, and it is a button: tapping it
 * lists each refused admission with the server's reason.
 */
export function SyncStatus({
  online,
  syncing,
  pending,
  refused,
  index,
  timeZone,
}: {
  online: boolean;
  syncing: boolean;
  pending: number;
  refused: readonly QueuedScan[];
  index: ManifestIndex;
  timeZone: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {refused.length > 0 ? (
        <Button
          variant="destructive"
          size="sm"
          className="h-9 shrink-0 gap-1 px-2"
          onClick={() => setOpen(true)}
          aria-label={`${refused.length} couldn't sync — tap for details`}
        >
          <CircleAlert />
          {refused.length} couldn&rsquo;t sync
        </Button>
      ) : !online ? (
        <Badge variant="destructive" className="shrink-0 gap-1">
          <CloudOff className="size-3" />
          {pending > 0 ? `Offline · ${pending} waiting` : 'Offline'}
        </Badge>
      ) : syncing && pending > 0 ? (
        <Badge variant="secondary" className="shrink-0 gap-1">
          <Spinner className="size-3" />
          Syncing {pending}
        </Badge>
      ) : pending > 0 ? (
        <Badge variant="secondary" className="shrink-0">
          {pending} waiting
        </Badge>
      ) : null}

      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerHeader>
            <DrawerTitle>Couldn&rsquo;t sync</DrawerTitle>
            <DrawerDescription>
              These people were let in, but the server would not record them. Tell the desk who they
              were. This phone will not send them again.
            </DrawerDescription>
          </DrawerHeader>
          <div className="max-h-[50svh] overflow-y-auto px-4">
            <ItemGroup className="gap-2">
              {refused.map((scan) => {
                const entry =
                  (scan.attendeeId != null && index.byKey.get(`a${scan.attendeeId}`)) ||
                  (scan.qrTokenSha256 ? index.byHash.get(scan.qrTokenSha256) : undefined);
                return (
                  <Item key={scan.id} variant="outline">
                    <ItemContent>
                      <ItemTitle className="text-base">
                        {entry?.name ?? 'A seat this phone no longer has'}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {formatDoorTime(scan.scannedAt, timeZone)}
                        {entry?.ticketCode ? ` · ${entry.ticketCode}` : ''}
                        <br />
                        {scan.refusedReason}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                );
              })}
            </ItemGroup>
          </div>
          <DrawerFooter>
            <Button
              size="lg"
              variant="outline"
              className="h-14 text-base"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
