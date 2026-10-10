'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RotateCcw, Send } from 'lucide-react';

/**
 * Press Send as often as you like (spec/email.md §11.4). The first press queues one message for the
 * party. While it is pending, every further press is a second insert that the partial unique index
 * turns away, and once it has gone the party's tickets are stamped as sent, so a later send skips
 * them. Either way Eleanor gets one email.
 */

type Status = 'idle' | 'QUEUED' | 'SENDING' | 'SENT';
type Bounce = { id: number; reason: 'index' | 'stamped' };

export function DoubleSend() {
  const [status, setStatus] = useState<Status>('idle');
  const [presses, setPresses] = useState(0);
  const [bounces, setBounces] = useState<Bounce[]>([]);
  const timers = useRef<number[]>([]);
  const nextId = useRef(0);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  function later(ms: number, fn: () => void) {
    timers.current.push(window.setTimeout(fn, ms));
  }

  function send() {
    setPresses((count) => count + 1);
    if (status === 'idle') {
      setStatus('QUEUED');
      // The dispatcher picks the row up a moment later, as the outbox does.
      later(2600, () => setStatus('SENDING'));
      later(3600, () => setStatus('SENT'));
      return;
    }
    const id = nextId.current++;
    setBounces((current) => [...current, { id, reason: status === 'SENT' ? 'stamped' : 'index' }]);
    later(1500, () => setBounces((current) => current.filter((bounce) => bounce.id !== id)));
  }

  function reset() {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    setStatus('idle');
    setPresses(0);
    setBounces([]);
  }

  const turnedAway = Math.max(0, presses - 1);

  return (
    <div className="zx-send">
      <div className="zx-send__table" aria-label="email_outbox">
        <div className="zx-send__head" aria-hidden>
          <code>email_outbox</code>
          <span className="zx-send__index">
            unique: <code>(registration_id, purpose)</code> while pending
          </span>
        </div>

        <div className="zx-send__rows">
          <AnimatePresence>
            {bounces.map((bounce) => (
              <motion.div
                key={bounce.id}
                className="zx-send__row zx-send__row--ghost"
                initial={{ opacity: 0, y: -28 }}
                animate={{ opacity: [0, 1, 1, 0], y: [-28, 0, 0, 0], x: [0, 0, -7, 6, -3, 0] }}
                transition={{ duration: 1.3, times: [0, 0.25, 0.7, 1], x: { delay: 0.32, duration: 0.36 } }}
                exit={{ opacity: 0 }}
              >
                <span>Eleanor Whitfield</span>
                <span className="zx-send__purpose">TICKETS</span>
                <span className="zx-send__verdict">
                  {bounce.reason === 'index' ? 'on conflict do nothing' : 'skipped: already sent'}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>

          {status === 'idle' ? (
            <p className="zx-send__empty">No messages yet. Press Send.</p>
          ) : (
            <motion.div
              className="zx-send__row"
              initial={{ opacity: 0, y: -18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', bounce: 0.2, visualDuration: 0.4 }}
            >
              <span>Eleanor Whitfield</span>
              <span className="zx-send__purpose">TICKETS</span>
              <span className="zx-send__status" data-status={status}>
                {status}
              </span>
            </motion.div>
          )}
        </div>
      </div>

      <p className="zx-send__tally" aria-live="polite">
        {presses === 0
          ? 'Eleanor will get one email, however many times you press it.'
          : `Pressed ${presses === 1 ? 'once' : `${presses} times`}. Turned away: ${turnedAway}. Emails to Eleanor: 1.`}
      </p>

      <div className="zx-note__actions">
        <button type="button" className="zx-btn zx-btn--ink" onClick={send}>
          <Send aria-hidden className="zx-btn__icon" />
          Send tickets
        </button>
        {presses > 0 && (
          <button type="button" className="zx-btn zx-btn--quiet" onClick={reset}>
            <RotateCcw aria-hidden className="zx-btn__icon" />
            Start again
          </button>
        )}
      </div>
    </div>
  );
}
