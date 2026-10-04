'use client';

import { CloudOff, RefreshCw, Undo2, Users } from 'lucide-react';
import type { DoorStats } from '@/lib/checkin/dashboard';
import type { QueuedWalkIn } from '@/lib/checkin/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { formatDoorTime } from './format';

/**
 * The door's numbers for the selected show (spec/v3.md §32.2, decision 59).
 *
 * **Two figures, from the server, for this show and no other:** everyone in the
 * hall across every phone and operator — tickets plus walk-ins, against the
 * hall's capacity and the confirmed seats still expected — and what this
 * operator admitted, from every phone they have used. Before §32.2 the tab
 * counted only this phone's own queue, which is the one number the person
 * deciding when to stop holding seats cannot use.
 *
 * Offline, the last server figures stay, marked with how old they are, and
 * this phone's unsynced admissions are shown beside them rather than guessed
 * into them.
 */
export function StatsTab({
  stats,
  online,
  timeZone,
  unsyncedAdmissions,
  unsyncedWalkIns,
  refused,
  walkIns,
  rosterFetchedAt,
  refreshing,
  onRefresh,
  onUndoWalkIn,
}: {
  stats: DoorStats | null;
  online: boolean;
  timeZone: string | null;
  /** This operator's admissions on this phone not yet on the server. */
  unsyncedAdmissions: number;
  /** Headcount of this operator's walk-ins not yet on the server. */
  unsyncedWalkIns: number;
  refused: number;
  walkIns: readonly QueuedWalkIn[];
  rosterFetchedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onUndoWalkIn: (clientId: string) => void;
}) {
  const unsynced = unsyncedAdmissions + unsyncedWalkIns;
  const asOf = stats ? formatDoorTime(stats.asOf, timeZone) : null;
  const percent =
    stats?.capacity ? Math.min(100, Math.round((stats.inHall / stats.capacity) * 100)) : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {stats === null ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">{online ? <Users /> : <CloudOff />}</EmptyMedia>
            <EmptyTitle>No figures yet</EmptyTitle>
            <EmptyDescription>
              {online
                ? 'Fetching the house total…'
                : 'The house total comes from the server. Connect once to see it.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-muted-foreground text-sm font-medium">In the hall</CardTitle>
              <CardDescription>Every phone, every operator</CardDescription>
              <CardAction>
                <AsOf online={online} asOf={asOf} />
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-5xl font-bold tabular-nums">
                {stats.inHall}
                {stats.capacity ? (
                  <span className="text-muted-foreground text-2xl font-medium"> / {stats.capacity}</span>
                ) : null}
              </p>
              {percent !== null && <Progress value={percent} aria-label={`${percent}% of capacity`} />}
              <p className="text-muted-foreground text-sm">
                {stats.checkedIn + stats.admittedUnconfirmed} with tickets · {stats.walkIns} walk-in
                {stats.walkIns === 1 ? '' : 's'} · {stats.remaining} still expected
              </p>
              {unsynced > 0 && (
                <p className="text-sm">
                  +{unsynced} from this phone not yet counted
                </p>
              )}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-muted-foreground text-sm font-medium">Admitted by you</CardTitle>
              <CardDescription>This show, from every phone you have used</CardDescription>
              <CardAction>
                <AsOf online={online} asOf={asOf} />
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-bold tabular-nums">
                {stats.byYou.admitted + stats.byYou.walkIns + unsynced}
              </p>
              <p className="text-muted-foreground text-sm">
                {stats.byYou.admitted} with tickets · {stats.byYou.walkIns} walk-in
                {stats.byYou.walkIns === 1 ? '' : 's'}
                {unsynced > 0 ? ` · ${unsynced} waiting to sync` : ''}
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {refused > 0 && (
        <p className="text-destructive text-sm">
          {refused} admission{refused === 1 ? '' : 's'} couldn&rsquo;t sync — tap the red badge at the
          top for details.
        </p>
      )}

      {walkIns.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Walk-ins on this phone
          </h2>
          <ItemGroup className="gap-2">
            {[...walkIns]
              .sort((a, b) => b.admittedAt.localeCompare(a.admittedAt))
              .map((w) => (
                <Item key={w.clientId} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {w.headcount} {w.headcount === 1 ? 'person' : 'people'}
                      {w.label ? ` · ${w.label}` : ''}
                    </ItemTitle>
                    <ItemDescription>
                      {formatDoorTime(w.admittedAt, timeZone)} ·{' '}
                      {w.refusedAt ? "couldn't sync" : w.syncedAt ? 'synced' : 'waiting to sync'}
                    </ItemDescription>
                  </ItemContent>
                  {!w.syncedAt && (
                    <ItemActions>
                      {/* An usher's own mistake, before the server has it. After
                          that, reverting is the desk's (§32.2). */}
                      <Button variant="ghost" className="h-11" onClick={() => onUndoWalkIn(w.clientId)}>
                        <Undo2 />
                        Undo
                      </Button>
                    </ItemActions>
                  )}
                </Item>
              ))}
          </ItemGroup>
        </section>
      )}

      <Button
        variant="outline"
        size="lg"
        className="mt-auto h-14"
        disabled={!online || refreshing}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
        Refresh roster and figures
      </Button>
      {rosterFetchedAt && (
        <p className="text-muted-foreground -mt-2 text-center text-xs">
          Roster from {formatDoorTime(rosterFetchedAt, timeZone)}
        </p>
      )}
    </div>
  );
}

/** When the server's figures are from, and that they are stale when offline (§32.2). */
function AsOf({ online, asOf }: { online: boolean; asOf: string | null }) {
  return (
    <Badge variant={online ? 'secondary' : 'outline'}>
      {!online && <CloudOff />}
      {online ? `as of ${asOf}` : `${asOf} · offline`}
    </Badge>
  );
}
