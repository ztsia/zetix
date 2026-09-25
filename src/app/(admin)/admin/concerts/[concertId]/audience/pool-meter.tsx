import { Gauge } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import type { PoolMeter } from '@/lib/audience/queries';

/**
 * The extras pool meter, kept from the V2 review board as the Needs review
 * view's toolbar (spec/v3.md §22.2): per segment with extras waiting, how many
 * seats are left for them. It is what makes the first-come walk decidable at a
 * glance — "7 left, 11 asked for" says where the line will fall before Grant
 * extras is pressed.
 *
 * Read from `segment_pool()`, the same figures `promote_seats()` checks, so
 * the meter and the run agree.
 */
export function PoolMeters({ meters }: { meters: PoolMeter[] }) {
  if (meters.length === 0) return null;
  return (
    <section aria-label="Extras pool" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {meters.map((meter) => {
        const { pool } = meter;
        const fits = meter.pendingSeats <= pool.extras_pool;
        return (
          <div key={meter.segmentId} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Gauge className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <span className="truncate text-sm font-medium">{meter.label}</span>
              </div>
              {meter.policy === 'REVIEW' ? null : (
                <Badge variant="outline" className="shrink-0">
                  {meter.policy === 'AUTO_FCFS' ? 'First come, automatic' : 'No policy set'}
                </Badge>
              )}
            </div>
            <p className="text-2xl font-semibold tabular-nums">
              {pool.extras_pool}
              <span className="text-muted-foreground ml-1.5 text-sm font-normal">
                seat{pool.extras_pool === 1 ? '' : 's'} left in the pool
              </span>
            </p>
            <p className={fits ? 'text-muted-foreground text-sm' : 'text-sm'}>
              <span className="tabular-nums">{meter.pendingSeats}</span> asked for by{' '}
              <span className="tabular-nums">{meter.pendingParties}</span>{' '}
              {meter.pendingParties === 1 ? 'party' : 'parties'}
              {fits ? ' — all of them fit.' : ' — the walk stops where the pool runs out.'}
            </p>
            {pool.sellable > 0 && (
              <Progress value={Math.min(100, Math.round((pool.confirmed / pool.sellable) * 100))}>
                <ProgressLabel className="text-muted-foreground text-xs">
                  {pool.confirmed} of {pool.sellable} confirmed
                  {pool.over > 0 ? `, ${pool.over} over` : ''}
                </ProgressLabel>
                <ProgressValue className="text-xs" />
              </Progress>
            )}
            {pool.base_released ? (
              <p className="text-muted-foreground text-xs">
                The claim deadline has passed; unclaimed base seats are in the pool.
              </p>
            ) : pool.unclaimed_base > 0 ? (
              <p className="text-muted-foreground text-xs">
                {pool.unclaimed_base} base seat{pool.unclaimed_base === 1 ? '' : 's'} still held for players until
                the claim deadline.
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
