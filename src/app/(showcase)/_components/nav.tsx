'use client';

import { useState } from 'react';
import { useMotionValueEvent, useScroll } from 'motion/react';
import { REPO_URL } from '../_lib/content';
import { Mark, Wordmark } from './mark';
import { useShowcase } from './root';

/** The programme's header: the mark, three ways in, and the demo. Takes a ground once scrolled. */
export function Nav() {
  const { openDemo, openFilm } = useShowcase();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 24));

  return (
    <header className="zx-nav" data-scrolled={scrolled ? '' : undefined}>
      <div className="zx-wrap zx-nav__bar">
        <a href="#top" className="zx-brand" aria-label="Zetix, back to the top">
          <Mark className="zx-brand__mark" />
          <Wordmark className="zx-brand__word" />
        </a>
        <nav aria-label="Zetix" className="zx-nav__links">
          <button type="button" className="zx-nav__link zx-nav__link--wide" onClick={openFilm}>
            Walkthrough
          </button>
          <a className="zx-nav__link" href={REPO_URL}>
            GitHub
          </a>
          <button type="button" className="zx-btn zx-btn--primary zx-btn--small" onClick={openDemo}>
            Open the demo
          </button>
        </nav>
      </div>
    </header>
  );
}
