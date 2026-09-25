'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCanEdit } from '@/components/auth/role';
import { RegistrationFormDialog } from '../registrations/registration-form-dialog';
import type { PlayerOption, SegmentOption } from '../registrations/queries';

/**
 * New party (spec/allocation.md §7.6), from the Audience header. What the engine
 * did with the seats is said beside the button — "2 confirmed, 1 waitlisted" is
 * not what a closing dialog would suggest.
 */
export function NewParty(props: {
  concertId: number;
  timeZone: string | null;
  segments: SegmentOption[];
  players: PlayerOption[];
}) {
  const [outcome, setOutcome] = React.useState<string | null>(null);
  // Creating a party is an admin's (spec/v3.md §28).
  if (!useCanEdit()) return null;
  return (
    <div className="flex flex-col items-end gap-2">
      <RegistrationFormDialog
        {...props}
        onSuccess={(result) => setOutcome(result.message ?? null)}
        trigger={
          <Button size="sm">
            <Plus data-icon="inline-start" />
            New party
          </Button>
        }
      />
      {outcome && (
        <Alert className="max-w-sm py-2" role="status">
          <AlertDescription>Party created: {outcome}.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
