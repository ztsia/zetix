'use client';

import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { RejectedSync } from '@/lib/checkin/rejected-sync';
import { formatInZone } from '@/lib/export';

/**
 * Scans refused because an operator's assignment had been revoked
 * (spec/admin.md §14.3).
 *
 * §14.3 requires that these are "surfaced to the admin rather than silently
 * dropped", and this is that surface. It is deliberately loud: the people in a
 * refused batch were let into the hall by an usher whose phone still believed it
 * was rostered, so they are inside the building and absent from every count on
 * the rest of this page.
 *
 * The fix is in the admin's hands and is said plainly, because at a door nobody
 * has time to work it out: re-assign the operator and have them sync again.
 */
export function RejectedSyncsAlert({
  rejected,
  timeZone,
}: {
  rejected: RejectedSync[];
  timeZone: string;
}) {
  if (rejected.length === 0) return null;

  const total = rejected.reduce((sum, entry) => sum + entry.scanCount, 0);

  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert />
      <AlertTitle>
        {total} scan{total === 1 ? '' : 's'} refused — the operator was not assigned to this
        show
      </AlertTitle>
      <AlertDescription>
        <p>
          These admissions were <strong>not recorded</strong>, so the guests are not in the
          counts above. If they should have been let in, assign the operator to this show again
          and have them reopen the scanner — the queue drains on their next sync.
        </p>
        <ul className="mt-2 space-y-1">
          {rejected.map((entry) => (
            <li key={entry.id} className="text-sm">
              <span className="font-medium">{entry.operatorName ?? 'Unknown operator'}</span>
              {entry.deviceId ? <> on {entry.deviceId}</> : null} — {entry.scanCount} scan
              {entry.scanCount === 1 ? '' : 's'}, refused at{' '}
              <span className="tabular-nums">
                {formatInZone(new Date(entry.at), timeZone)}
              </span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
