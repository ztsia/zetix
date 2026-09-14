'use client';

import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { overrideVerificationAction } from './actions';
import type { UnverifiedRegistration } from './queries';

/**
 * The unverified list, with the override beside each row.
 *
 * **A plain `Table`, not the shared `DataTable`.** `modules.md` §4 says never to
 * fork `DataTable`, and this does not: the rule is about not rebuilding it, and
 * `DataTable` is the interactive one — sorting, filtering, pagination, server
 * mode. This list is short by construction (it is the parties who have not
 * clicked yet), already ordered by how long they have waited, and has exactly
 * one action per row. Reaching for the interactive table here would add a
 * filter bar and a paginator to a screen whose whole job is "these few people
 * cannot be reached".
 */

export function UnverifiedTable({
  concertId,
  rows,
}: {
  concertId: number;
  rows: UnverifiedRegistration[];
}) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const release = (registrationId: number) => {
    setBusyId(registrationId);
    setNote(null);
    startTransition(async () => {
      const result = await overrideVerificationAction(concertId, registrationId);
      setNote(result.error ?? result.message ?? null);
      setBusyId(null);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Registrant</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Show</TableHead>
              <TableHead className="text-right">Seats</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {row.contactName}
                  {row.roundLabel ? (
                    <span className="ml-2 text-xs text-muted-foreground">{row.roundLabel}</span>
                  ) : null}
                </TableCell>
                {/*
                  The address is the point of this screen — it is what is
                  probably wrong — so it is rendered at full width and never
                  truncated. `break-all` because a long address that wraps is
                  readable and one that is cut off is what hides the typo.
                */}
                <TableCell className="break-all">{row.contactEmail}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.showName} · {row.segmentName}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.seats}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.overdue ? (
                    <Badge variant="destructive">{row.hoursWaiting}h</Badge>
                  ) : (
                    <span className="text-muted-foreground">{row.hoursWaiting}h</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => release(row.id)}
                  >
                    {pending && busyId === row.id ? <Spinner data-icon="inline-start" /> : null}
                    Release
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
