'use client';

import { MailQuestion } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { AdminOnly } from '@/components/auth/role';
import { Button } from '@/components/ui/button';
import { CommandDialog } from '../commands/command-dialog';

/**
 * The checklist's one fix that needs no other screen: run the address checks
 * over every party (spec/v3.md §24.6). Parties from before V3 were never
 * checked, so a concert carried over from V2 needs this once. It is the
 * Audience workspace's own command, over a filter selection of everything, so
 * its preview says what it will do before it does it.
 */
export function CheckAddressesButton({ concertId }: { concertId: number }) {
  const router = useRouter();
  return (
    <AdminOnly>
      <CommandDialog
        concertId={concertId}
        command="audience.check_address"
        selection={{ filter: {}, excludedIds: [] }}
        onDone={() => router.refresh()}
        trigger={
          <Button size="sm" variant="outline">
            <MailQuestion data-icon="inline-start" />
            Check every address
          </Button>
        }
      />
    </AdminOnly>
  );
}
