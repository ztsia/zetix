'use client';

import { useEffect, useRef, useState } from 'react';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { Lock, LockOpen, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Two guests ask for the last seat at the same instant, and `claim_seats()` decides
 * (spec/allocation.md §7.8). Played as a script, step by step, so the order is visible: with the
 * lock, the second request waits and then counts again; without it, both count one free seat and
 * the hall is oversold. The second version is the bug the lock exists for.
 */

type Place = 'queue' | 'holder' | 'inside' | 'waiting' | 'seat' | 'extra' | 'waitlist';
type Guest = 'iris' | 'lucian';

type Frame = {
  at: number;
  iris: Place;
  lucian: Place;
  lock: Guest | null;
  /** What each request has counted, when it has. */
  reads?: Partial<Record<Guest, string>>;
  line: string;
};

const WITH_LOCK: Frame[] = [
  { at: 0, iris: 'queue', lucian: 'queue', lock: null, line: 'Two requests for the last seat, sent in the same instant.' },
  { at: 650, iris: 'holder', lucian: 'waiting', lock: 'iris', line: 'Iris’s request takes the lock on the hall. Lucian’s has to wait for it.' },
  { at: 1500, iris: 'holder', lucian: 'waiting', lock: 'iris', reads: { iris: '1 free' }, line: 'Holding the lock, Iris’s request counts one free seat.' },
  { at: 2300, iris: 'seat', lucian: 'waiting', lock: 'iris', line: 'It takes the seat, and the transaction commits.' },
  { at: 3000, iris: 'seat', lucian: 'holder', lock: 'lucian', reads: { lucian: '0 free' }, line: 'The lock passes to Lucian’s request, which counts again: no seat left.' },
  { at: 3900, iris: 'seat', lucian: 'waitlist', lock: null, line: 'Lucian is waitlisted. One seat, one guest.' },
];

const WITHOUT_LOCK: Frame[] = [
  { at: 0, iris: 'queue', lucian: 'queue', lock: null, line: 'Two requests for the last seat, sent in the same instant.' },
  { at: 650, iris: 'holder', lucian: 'inside', lock: null, line: 'With no lock, both requests are inside at once.' },
  { at: 1500, iris: 'holder', lucian: 'inside', lock: null, reads: { iris: '1 free', lucian: '1 free' }, line: 'Each counts one free seat, before either has written anything.' },
  { at: 2400, iris: 'seat', lucian: 'extra', lock: null, line: 'Both take it. Twenty-five guests for twenty-four seats: oversold.' },
];

const SEATS = 24;

export function LockRace() {
  const [locked, setLocked] = useState(true);
  const [frame, setFrame] = useState(0);
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);
  const reduce = useReducedMotion();

  const script = locked ? WITH_LOCK : WITHOUT_LOCK;
  const current = script[Math.min(frame, script.length - 1)];
  const finished = frame === script.length - 1;

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  function run(withLock: boolean) {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    const next = withLock ? WITH_LOCK : WITHOUT_LOCK;
    setLocked(withLock);
    setFrame(0);
    if (reduce) {
      setFrame(next.length - 1);
      return;
    }
    setRunning(true);
    next.forEach((step, index) => {
      if (index === 0) return;
      timers.current.push(
        window.setTimeout(() => {
          setFrame(index);
          if (index === next.length - 1) setRunning(false);
        }, step.at),
      );
    });
  }

  const taken = current.iris === 'seat' || current.lucian === 'seat';
  const oversold = current.lucian === 'extra';

  return (
    <div className="zx-race" data-locked={locked ? '' : undefined}>
      <LayoutGroup id="race">
        <div className="zx-race__board">
          <div className="zx-race__col zx-race__col--queue">
            <p className="zx-race__label">Requests</p>
            <div className="zx-race__slots">
              <Slot guest="iris" here={current.iris === 'queue'} reads={current.reads} />
              <Slot guest="lucian" here={current.lucian === 'queue'} reads={current.reads} />
            </div>
          </div>

          <div className="zx-race__col zx-race__fn">
            <p className="zx-race__label">
              <code>claim_seats()</code>
            </p>
            <div className={cn('zx-race__room', current.lock && 'zx-race__room--held')}>
              <span className="zx-race__lock" aria-hidden>
                {locked ? current.lock ? <Lock /> : <LockOpen /> : null}
              </span>
              <div className="zx-race__slots">
                {(['iris', 'lucian'] as const).map((guest) => (
                  <Slot key={guest} guest={guest} here={current[guest] === 'holder'} reads={current.reads} holding={current.lock === guest} />
                ))}
                {(['iris', 'lucian'] as const).map((guest) => (
                  <Slot key={`in-${guest}`} guest={guest} here={current[guest] === 'inside'} reads={current.reads} />
                ))}
              </div>
            </div>
            <div className="zx-race__door">
              {(['iris', 'lucian'] as const).map((guest) => (
                <Slot key={guest} guest={guest} here={current[guest] === 'waiting'} reads={current.reads} waiting />
              ))}
            </div>
          </div>

          <div className="zx-race__col zx-race__hall">
            <p className="zx-race__label">The hall</p>
            <div className="zx-race__seats" aria-hidden>
              {Array.from({ length: SEATS }, (_, index) => (
                <i
                  key={index}
                  data-last={index === SEATS - 1 ? '' : undefined}
                  data-taken={index < SEATS - 1 || taken ? '' : undefined}
                />
              ))}
              {oversold && <i data-extra="" />}
            </div>
            <div className="zx-race__landing">
              {(['iris', 'lucian'] as const).map((guest) => (
                <Slot key={guest} guest={guest} here={current[guest] === 'seat'} reads={current.reads} seated />
              ))}
              {(['iris', 'lucian'] as const).map((guest) => (
                <Slot key={`x-${guest}`} guest={guest} here={current[guest] === 'extra'} reads={current.reads} oversold />
              ))}
            </div>
            <div className="zx-race__waitlist">
              {(['iris', 'lucian'] as const).map((guest) => (
                <Slot key={guest} guest={guest} here={current[guest] === 'waitlist'} reads={current.reads} waitlisted />
              ))}
            </div>
          </div>
        </div>
      </LayoutGroup>

      <p className={cn('zx-race__line', finished && !locked && 'zx-race__line--bad')} aria-live="polite">
        {current.line}
      </p>

      <div className="zx-note__actions">
        <button type="button" className="zx-btn zx-btn--ink" onClick={() => run(true)} disabled={running}>
          {frame > 0 && locked ? <RotateCcw aria-hidden className="zx-btn__icon" /> : null}
          {frame > 0 && locked ? 'Run it again' : 'Race for the last seat'}
        </button>
        <button type="button" className="zx-btn zx-btn--quiet" onClick={() => run(false)} disabled={running}>
          Try it without the lock
        </button>
      </div>
    </div>
  );
}

const NAMES: Record<Guest, string> = { iris: 'Iris', lucian: 'Lucian' };

/**
 * One guest's request, drawn wherever the script has it. Every place renders a slot for each guest;
 * only the one they are in shows them, and `layoutId` carries the chip from one to the next.
 */
function Slot({
  guest,
  here,
  reads,
  holding,
  waiting,
  seated,
  waitlisted,
  oversold,
}: {
  guest: Guest;
  here: boolean;
  reads?: Partial<Record<Guest, string>>;
  holding?: boolean;
  waiting?: boolean;
  seated?: boolean;
  waitlisted?: boolean;
  oversold?: boolean;
}) {
  if (!here) return null;
  return (
    <motion.span
      layoutId={`race-${guest}`}
      className={cn(
        'zx-chip',
        holding && 'zx-chip--holding',
        waiting && 'zx-chip--waiting',
        seated && 'zx-chip--seated',
        waitlisted && 'zx-chip--waitlisted',
        oversold && 'zx-chip--oversold',
      )}
      transition={{ type: 'spring', bounce: 0.18, visualDuration: 0.5 }}
    >
      {NAMES[guest]}
      {reads?.[guest] && <span className="zx-chip__read">{reads[guest]}</span>}
      {seated && <span className="zx-chip__read">seated</span>}
      {waitlisted && <span className="zx-chip__read">waitlisted</span>}
      {oversold && <span className="zx-chip__read">no seat</span>}
    </motion.span>
  );
}
