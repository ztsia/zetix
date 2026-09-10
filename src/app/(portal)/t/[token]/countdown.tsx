'use client';

import { useEffect, useState } from 'react';
import { countdownTo } from '@/lib/portal/format';

/**
 * The §13.2 countdown, and the only client component on this surface.
 *
 * **The server renders the first label and this component starts from it.** Two
 * things fall out of that, both deliberate:
 *
 * - No hydration mismatch. Computing from `Date.now()` on the first client
 *   render would differ from the server's HTML whenever the two straddle a
 *   minute boundary; seeding state with the server's own string makes the first
 *   client render identical by construction.
 * - **No state is set during the effect**, only inside the interval. The page is
 *   `force-dynamic`, so the seeded label is already correct at paint and has
 *   nothing to catch up on — which lets this satisfy `react-hooks/set-state-in-effect`
 *   honestly rather than by suppressing it.
 *
 * It ticks every 30 seconds because {@link countdownTo} is accurate to the
 * minute; a one-second timer would wake the phone sixty times as often to
 * produce the same string.
 */
export function Countdown({
  /** ISO instant, so the client re-derives from the same value the server used. */
  targetIso,
  initialLabel,
  openLabel,
}: {
  targetIso: string;
  initialLabel: string;
  openLabel: string;
}) {
  const [label, setLabel] = useState(initialLabel);

  useEffect(() => {
    const target = new Date(targetIso);
    const timer = setInterval(() => {
      const next = countdownTo(target, new Date());
      if (next) setLabel(next.open ? openLabel : `in ${next.label}`);
    }, 30_000);
    return () => clearInterval(timer);
  }, [targetIso, openLabel]);

  return <span>{label}</span>;
}
