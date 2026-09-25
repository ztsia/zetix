'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ActionDialog } from '../../action-dialog';
import { commitReviewAction } from './actions';
import { OVERSELL_PHRASE } from '@/lib/registrations/confirmation';
import type { ReviewBoardData, ReviewRow, ReviewSegmentOption } from './queries';
import { AdminOnly } from '@/components/auth/role';

/**
 * The extras review screen (spec/allocation.md §7.5).
 *
 * > Preselection is a strict FCFS greedy walk by cumulative seat count … Admin
 * > toggles rows and edits granted counts freely; the header recomputes live.
 * > Ticking beyond the pool is **allowed** — the row is flagged, the header
 * > shows the overage … Preselection is the recommendation; the admin is the
 * > decision.
 *
 * So the walk arrives as the initial state and nothing here re-runs it: once an
 * admin has touched a row, recomputing would take their decision away. The
 * **Reset to FCFS** button is how they ask for it back.
 *
 * A plain `Table`, not the shared `DataTable`: every row is an editable input
 * whose value feeds a live total, and the queue is a single ordered list that
 * must never be sorted into a different order — sorting it by seats or by name
 * would silently misrepresent first-come-first-served as something else.
 */
export function ReviewBoard({
  concertId,
  data,
  segments,
  timeZone,
}: {
  concertId: number;
  data: ReviewBoardData;
  segments: ReviewSegmentOption[];
  timeZone: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Seats granted per registration, keyed by id. Starts as the FCFS walk. */
  const [granted, setGranted] = useState<Record<number, number>>(() =>
    fromPreselection(data),
  );
  const [touched, setTouched] = useState(false);

  const rows = useMemo(
    () =>
      // The running total of §7.5's cumulative column, built by folding rather
      // than by mutating a counter across the map: the React compiler rejects
      // the latter, and the fold says the same thing.
      data.requests.reduce<(ReviewRow & { cumulative: number; granted: number })[]>(
        (acc, request) => [
          ...acc,
          {
            ...request,
            cumulative: (acc.at(-1)?.cumulative ?? 0) + request.seatsRequested,
            granted: granted[request.registrationId] ?? 0,
          },
        ],
        [],
      ),
    [data.requests, granted],
  );

  const selectedSeats = rows.reduce((total, row) => total + row.granted, 0);
  const requestedSeats = rows.reduce((total, row) => total + row.seatsRequested, 0);
  const { extras_pool: pool, open_seats: openSeats, over } = data.pool;

  /** Past the pool is a warning; past the capacity is what needs confirming. */
  const pastPool = selectedSeats > pool;
  const pastCapacity = selectedSeats > Math.max(0, openSeats);

  function set(registrationId: number, value: number, max: number) {
    setTouched(true);
    setGranted((current) => ({
      ...current,
      [registrationId]: Math.max(0, Math.min(value, max)),
    }));
  }

  function commit(confirmation: string, override: boolean) {
    setError(null);
    setNotice(null);
    return commitReviewAction(concertId, {
      segmentId: data.segment.id,
      decisions: rows.map((row) => ({
        registrationId: row.registrationId,
        granted: row.granted,
      })),
      override,
      confirmation,
    }).then((result) => {
      if (result.error) setError(result.error);
      else {
        setNotice(result.message ?? null);
        setTouched(false);
        router.refresh();
      }
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Extras review</h1>
          <p className="text-muted-foreground text-sm">
            {data.segment.showName} · {data.segment.name}
          </p>
        </div>
        <SegmentPicker concertId={concertId} segments={segments} current={data.segment.id} />
      </div>

      <PoolHeader
        pool={pool}
        openSeats={openSeats}
        over={over}
        requests={rows.length}
        requestedSeats={requestedSeats}
        selectedSeats={selectedSeats}
        baseReleased={data.pool.base_released}
        unclaimedBase={data.pool.unclaimed_base}
      />

      {notice && (
        <Alert role="status">
          <Check />
          <AlertTitle>Committed</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
            {error}
          </AlertTitle>
        </Alert>
      )}

      {rows.length === 0 ? (
        <Empty className="border-border min-h-[40vh] rounded-lg border border-dashed">
          <EmptyHeader>
            <EmptyTitle>Nothing waiting for review</EmptyTitle>
            <EmptyDescription>
              Extras requests in this segment appear here as they arrive. A segment on{' '}
              <code>AUTO_FCFS</code> grants them at submission instead, so it never
              queues.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Guests</TableHead>
                  <TableHead className="text-right">Seats</TableHead>
                  <TableHead className="text-right">Cumulative</TableHead>
                  <TableHead className="w-32 text-right">Grant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  const partial = row.granted > 0 && row.granted < row.seatsRequested;
                  const beyond = row.cumulative > pool;
                  return (
                    <TableRow
                      key={row.registrationId}
                      className={cn(row.granted > 0 && 'bg-muted/40')}
                    >
                      <TableCell className="text-muted-foreground tabular-nums">
                        {index + 1}
                      </TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap">
                        {formatInZone(row.requestedAt, timeZone)}
                        {row.roundLabel && (
                          <span className="text-muted-foreground ml-2 text-xs">
                            {row.roundLabel}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.playerName ?? <span className="text-muted-foreground">—</span>}
                        {row.seatsConfirmed > 0 && (
                          <span className="text-muted-foreground ml-2 text-xs">
                            holds {row.seatsConfirmed}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{row.contactName}</span>
                          {row.contactEmail && (
                            <span className="text-muted-foreground text-xs">
                              {row.contactEmail}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[18rem]">
                        <span className="text-muted-foreground text-xs">
                          {row.guestNames.join(', ')}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.seatsRequested}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          beyond && 'text-muted-foreground',
                        )}
                      >
                        {row.cumulative}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          {partial && (
                            <Tooltip>
                              <TooltipTrigger
                                render={<Badge variant="secondary">part</Badge>}
                              />
                              <TooltipContent>
                                {row.granted} of {row.seatsRequested} seats; the rest
                                are waitlisted on commit.
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <Checkbox
                            checked={row.granted > 0}
                            aria-label={`Grant ${row.contactName}`}
                            onCheckedChange={(checked: boolean) =>
                              set(
                                row.registrationId,
                                checked ? row.seatsRequested : 0,
                                row.seatsRequested,
                              )
                            }
                          />
                          <Input
                            type="number"
                            min={0}
                            max={row.seatsRequested}
                            value={row.granted}
                            aria-label={`Seats granted to ${row.contactName}`}
                            className="h-8 w-16 text-right tabular-nums"
                            onChange={(event) =>
                              set(
                                row.registrationId,
                                Number(event.target.value),
                                row.seatsRequested,
                              )
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {pastPool && (
            <Alert variant={pastCapacity ? 'destructive' : 'default'}>
              <AlertTriangle />
              <AlertTitle>
                {selectedSeats - pool} seat{selectedSeats - pool === 1 ? '' : 's'} past
                the extras pool
              </AlertTitle>
              <AlertDescription>
                {pastCapacity
                  ? `That is past the segment's capacity as well, so committing needs the typed confirmation and is recorded in the audit log.`
                  : `Inside the segment's capacity, so this commits normally — the pool holds back seats the players have not claimed yet, and granting into them is a decision you are allowed to make.`}
              </AlertDescription>
            </Alert>
          )}

          <AdminOnly>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!touched || isPending}
                onClick={() =>
                  startTransition(() => {
                    setGranted(fromPreselection(data));
                    setTouched(false);
                  })
                }
              >
                <RotateCcw /> Reset to FCFS
              </Button>

              {pastCapacity ? (
                <ActionDialog
                  trigger={
                    <Button variant="destructive" disabled={isPending}>
                      Commit {selectedSeats} seat{selectedSeats === 1 ? '' : 's'} over
                      capacity
                    </Button>
                  }
                  title="Commit past capacity?"
                  description={`This grants ${selectedSeats} seats where ${Math.max(0, openSeats)} are free. More people will hold a ticket than the segment has room for, and the override is written to the audit log.`}
                  submitLabel="Commit over capacity"
                  pendingLabel="Committing…"
                  submitVariant="destructive"
                  action={(formData) =>
                    commit(String(formData.get('confirmation') ?? ''), true)
                  }
                >
                  <Field>
                    <FieldLabel htmlFor="confirmation">
                      Type {OVERSELL_PHRASE} to confirm
                    </FieldLabel>
                    <Input id="confirmation" name="confirmation" autoComplete="off" autoFocus />
                    <FieldDescription>
                      §7.5 asks for a typed confirmation, and records it with the commit.
                    </FieldDescription>
                  </Field>
                </ActionDialog>
              ) : (
                <Button
                  disabled={isPending}
                  onClick={() => startTransition(() => void commit('', false))}
                >
                  {isPending && <Spinner />}
                  Commit {selectedSeats} seat{selectedSeats === 1 ? '' : 's'}
                </Button>
              )}
            </div>
          </AdminOnly>

          <p className="text-muted-foreground text-sm">
            Committing confirms the granted seats and waitlists the rest of the parties
            listed here, in one transaction. Emails are prepared on the Email screen
            afterwards — nothing is sent from this button.
          </p>
        </>
      )}
    </div>
  );
}

/** The live figures of §7.5's header. */
function PoolHeader({
  pool,
  openSeats,
  over,
  requests,
  requestedSeats,
  selectedSeats,
  baseReleased,
  unclaimedBase,
}: {
  pool: number;
  openSeats: number;
  over: number;
  requests: number;
  requestedSeats: number;
  selectedSeats: number;
  baseReleased: boolean;
  unclaimedBase: number;
}) {
  return (
    <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-4">
      <Figure
        label="Extras pool"
        value={pool}
        hint={
          over > 0
            ? `full, ${over} over`
            : baseReleased
              ? `${unclaimedBase} base seats released`
              : `${unclaimedBase} still owed to players`
        }
      />
      <Figure label="Requests" value={requests} hint={`${requestedSeats} seats asked for`} />
      <Figure
        label="Selected"
        value={selectedSeats}
        hint={selectedSeats > pool ? `${selectedSeats - pool} past the pool` : 'within the pool'}
        tone={selectedSeats > pool ? 'warn' : undefined}
      />
      <Figure
        label="Free in segment"
        value={Math.max(0, openSeats)}
        hint={over > 0 ? `full, ${over} over` : 'the ceiling a commit is checked against'}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone?: 'warn';
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs uppercase">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'warn' && 'text-destructive',
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </div>
  );
}

function SegmentPicker({
  concertId,
  segments,
  current,
}: {
  concertId: number;
  segments: ReviewSegmentOption[];
  current: number;
}) {
  const router = useRouter();
  return (
    <Field className="w-auto">
      <FieldLabel htmlFor="segment-picker">Segment</FieldLabel>
      <NativeSelect
        id="segment-picker"
        value={String(current)}
        className="w-auto"
        onChange={(event) =>
          router.push(
            `/admin/concerts/${concertId}/extras-review?segment=${event.target.value}`,
          )
        }
      >
        {segments.map((segment) => (
          <option key={segment.id} value={segment.id}>
            {segment.label}
            {segment.pending > 0 ? ` — ${segment.pending} waiting` : ''}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** The FCFS walk, as the initial granted-count state. */
function fromPreselection(data: ReviewBoardData): Record<number, number> {
  const granted: Record<number, number> = {};
  for (const row of data.preselection) granted[row.registrationId] = row.granted;
  return granted;
}

/** Instants render in the concert's zone, never the viewer's (spec/domain.md §6.1). */
function formatInZone(value: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}
