'use client';

import { CloudOff, RefreshCw } from 'lucide-react';
import type { ManifestIndex } from '@/lib/checkin/manifest';
import type { LocalCheckIn } from '@/lib/checkin/evaluate';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Checked in, expected, remaining (spec/checkin.md §12.4 for the admin view;
 * ref.md §1.2 for this one).
 *
 * **The person running the door reads this to decide when to stop holding
 * seats**, so the number that matters is the one from this device's own
 * history — which is available offline, and is the only one that is.
 *
 * It is deliberately honest about being partial: with several ushers on several
 * phones, a single device knows only what it admitted itself until everything
 * syncs. The copy names no count — how many ushers there are is a fact in
 * `context.md`, and a number from there in a `.ts` file is a bug (`CLAUDE.md`),
 * even as prose.
 * Presenting that as the house count would be worse than useless on the one
 * night it is consulted, so the copy says whose count it is.
 */
export function StatsTab({
  index,
  checkIns,
  pending,
  online,
  refreshing,
  onRefresh,
}: {
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  pending: number;
  online: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const expected = index.entries.filter((e) => e.status !== 'CANCELLED').length;
  const admitted = new Set(
    checkIns.filter((c) => !c.revertedAt).map((c) => c.qrTokenSha256),
  ).size;
  const remaining = Math.max(expected - admitted, 0);
  const percent = expected === 0 ? 0 : Math.round((admitted / expected) * 100);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3">
        <Figure label="Admitted here" value={admitted} />
        <Figure label="Remaining" value={remaining} />
        <Figure label="Expected" value={expected} />
        <Figure label="Awaiting sync" value={pending} muted={pending === 0} />
      </div>

      <div className="space-y-2">
        <Progress value={percent} aria-label={`${percent}% admitted`} />
        <p className="text-muted-foreground text-xs">
          {percent}% of the roster on this device
        </p>
      </div>

      <Alert>
        <AlertTitle>This phone&rsquo;s count</AlertTitle>
        <AlertDescription>
          Every phone at the door sees only its own admissions until everything syncs. The
          dashboard has the house total.
        </AlertDescription>
      </Alert>

      {!online && (
        <Alert variant="destructive">
          <CloudOff />
          <AlertTitle>Offline</AlertTitle>
          <AlertDescription>
            Scanning works normally. {pending} scan{pending === 1 ? '' : 's'} will send when
            signal returns.
          </AlertDescription>
        </Alert>
      )}

      <Button
        variant="outline"
        size="lg"
        className="h-14"
        disabled={!online || refreshing}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
        Refresh roster
      </Button>
    </div>
  );
}

function Figure({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="bg-card rounded-lg border p-4">
      {/* Tabular numerals so the count does not jitter as it ticks up. */}
      <p className={`text-4xl font-bold tabular-nums ${muted ? 'text-muted-foreground' : ''}`}>
        {value}
      </p>
      <p className="text-muted-foreground mt-1 text-xs tracking-wide uppercase">{label}</p>
    </div>
  );
}
