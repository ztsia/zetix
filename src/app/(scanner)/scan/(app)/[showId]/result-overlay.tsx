'use client';

import { CheckCircle2, CircleAlert, CircleSlash, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScanResult } from '@/lib/checkin/evaluate';
import { Button } from '@/components/ui/button';

/**
 * The scan result, over the camera (spec/checkin.md §12.1, spec/ref.md §1.2).
 *
 * **An overlay, never a navigation event.** The camera stays mounted and
 * running behind it — re-initialising a stream costs 1–3 seconds on mid-range
 * Android, which with 400 people arriving in twenty minutes is the difference
 * between a queue and a crowd (ref.md §1.4).
 *
 * **Colour carries the meaning on its own.** That is not a preference: on an
 * iPhone there is no vibration at all, and on one with the ringer switch set to
 * silent there may be no sound either, which leaves this the only channel. So
 * every state gets a full-bleed ground, an icon whose *shape* differs (not just
 * its colour, for the colour-blind usher), and the verdict in words at a size
 * readable at arm's length in a dim foyer.
 */

const TONE_CLASS = {
  admitted: 'bg-[var(--scan-admitted)] text-black',
  duplicate: 'bg-[var(--scan-duplicate)] text-black',
  error: 'bg-[var(--scan-error)] text-white',
} as const;

const HEADLINE: Record<ScanResult['outcome'], string> = {
  ADMITTED: 'Admitted',
  ALREADY_CHECKED_IN: 'Already checked in',
  WRONG_SHOW: 'Wrong show',
  CANCELLED: 'Cancelled',
  NOT_FOUND: 'Invalid ticket',
};

function Icon({ outcome }: { outcome: ScanResult['outcome'] }) {
  const className = 'size-16 shrink-0';
  switch (outcome) {
    case 'ADMITTED':
      return <CheckCircle2 className={className} aria-hidden />;
    case 'ALREADY_CHECKED_IN':
      return <TriangleAlert className={className} aria-hidden />;
    case 'CANCELLED':
      return <CircleSlash className={className} aria-hidden />;
    default:
      return <CircleAlert className={className} aria-hidden />;
  }
}

export function ResultOverlay({
  result,
  onDismiss,
  onOpenDetail,
  onAdmitAnyway,
}: {
  result: ScanResult;
  onDismiss: () => void;
  onOpenDetail: () => void;
  onAdmitAnyway: () => void;
}) {
  const admitted = result.outcome === 'ADMITTED';

  return (
    <div
      // `alert` rather than `status`: this interrupts, and a screen reader user
      // at a door needs it now rather than at the next polite opportunity.
      role="alert"
      aria-live="assertive"
      data-outcome={result.outcome}
      data-slot="scan-result"
      className={cn(
        'absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 p-6 text-center',
        TONE_CLASS[result.tone],
      )}
    >
      <Icon outcome={result.outcome} />

      <p className="text-3xl leading-tight font-bold tracking-tight">
        {HEADLINE[result.outcome]}
      </p>

      {result.entry ? (
        <div className="space-y-1">
          <p className="text-2xl leading-tight font-semibold uppercase">{result.entry.name}</p>
          {result.entry.playerName && (
            <p className="text-base opacity-80">Guest of {result.entry.playerName}</p>
          )}
          {result.entry.ticketCode && (
            <p className="font-mono text-sm opacity-70">{result.entry.ticketCode}</p>
          )}
        </div>
      ) : (
        <p className="text-base opacity-80">
          Nothing on this device matches that code. Try Search, or the desk.
        </p>
      )}

      {result.outcome === 'CANCELLED' && (
        // §7.9: never "not found". The person and their seat were both real.
        <p className="text-lg font-semibold">Refer to desk</p>
      )}

      {result.outcome === 'WRONG_SHOW' && result.wrongShowName && (
        <p className="text-lg font-semibold">This ticket is for {result.wrongShowName}</p>
      )}

      {result.firstScan && (
        <p className="text-sm opacity-80">
          First scanned {formatTime(result.firstScan.at)}
          {result.firstScan.operatorName ? ` by ${result.firstScan.operatorName}` : ''}
        </p>
      )}

      {result.party && result.party.size > 1 && (
        <p className="text-lg font-semibold">
          Party of {result.party.size} · {result.party.admitted} in,{' '}
          {result.party.remaining} remaining
        </p>
      )}

      <div className="mt-2 flex w-full max-w-xs flex-col gap-2">
        {result.entry && (result.party?.remaining ?? 0) > 0 && admitted && (
          <Button size="lg" variant="secondary" className="h-14 text-base" onClick={onOpenDetail}>
            Admit remaining {result.party?.remaining}
          </Button>
        )}

        {!admitted && result.canAdmitAnyway && (
          // Amber and red are never hard blocks (§12.1). Turning away a real
          // guest at a free concert is worse than a duplicate row.
          <Button size="lg" variant="secondary" className="h-14 text-base" onClick={onAdmitAnyway}>
            Admit anyway
          </Button>
        )}

        <Button
          size="lg"
          variant="ghost"
          className="h-14 text-base hover:bg-black/10"
          onClick={onDismiss}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
