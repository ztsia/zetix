'use client';

import { useRef } from 'react';
import { motion, useInView } from 'motion/react';
import { DECISIONS_URL, REPO_URL } from '../_lib/content';
import { TEAR_STUB_TRANSFORM, TEAR_UPPER } from '../_lib/tear';
import { Wordmark } from './mark';
import { useShowcase } from './root';

/**
 * Curtain: the film's end card. The two halves of the ticket fly back in from where the door tore
 * them and meet as the mark, once, when it comes into view. Then the ways in.
 */
export function Curtain() {
  const { openDemo } = useShowcase();
  const mark = useRef<HTMLDivElement>(null);
  // Reduced motion needs no branch here: `MotionConfig` makes the flight instant and keeps the fade.
  const whole = useInView(mark, { once: true, amount: 0.6 });
  const meet = { type: 'spring', bounce: 0.28, visualDuration: 0.75 } as const;

  return (
    <section id="curtain" className="zx-curtain" data-cue="down" aria-labelledby="zx-curtain-title">
      <div className="zx-wrap zx-curtain__inner">
        <div ref={mark} className="zx-curtain__lockup" aria-hidden>
          <svg viewBox="0 0 64 64" className="zx-curtain__mark">
            <motion.g
              initial={false}
              animate={whole ? { x: 0, y: 0, rotate: 0, opacity: 1 } : { x: -16, y: -11, rotate: -9, opacity: 0 }}
              transition={meet}
            >
              <path className="zx-mark__ticket" d={TEAR_UPPER} />
            </motion.g>
            <motion.g
              initial={false}
              animate={whole ? { x: 0, y: 0, rotate: 0, opacity: 1 } : { x: 18, y: 14, rotate: 12, opacity: 0 }}
              transition={{ ...meet, delay: 0.08 }}
            >
              <path className="zx-mark__stub" d={TEAR_UPPER} transform={TEAR_STUB_TRANSFORM} />
            </motion.g>
          </svg>
          <motion.span
            initial={false}
            animate={whole ? { opacity: 1, x: 0 } : { opacity: 0, x: -18 }}
            transition={{ duration: 0.6, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <Wordmark className="zx-curtain__word" />
          </motion.span>
        </div>

        <h2 id="zx-curtain-title" className="zx-curtain__title">
          The house is open.
        </h2>
        <p className="zx-curtain__lead">
          Sign in to the demo as a read-only viewer, or read the code and the decisions behind it.
        </p>
        <div className="zx-curtain__actions">
          <button type="button" className="zx-btn zx-btn--primary" onClick={openDemo}>
            Open the demo
          </button>
          <a className="zx-btn zx-btn--ghost" href={DECISIONS_URL}>
            Read the decisions
          </a>
          <a className="zx-btn zx-btn--ghost" href={REPO_URL}>
            GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
