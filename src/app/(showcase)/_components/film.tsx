'use client';

import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { MEDIA, WALKTHROUGH_LENGTH } from '../_lib/content';
import { Mark } from './mark';
import { useShowcase } from './root';

/**
 * The walkthrough, behind its cover (spec/v3.md §31): a still that loads the player only when
 * pressed. The cover is the YouTube thumbnail; until it is committed, a title card in the same
 * layout stands in.
 */
export function Film() {
  const { openFilm } = useShowcase();
  const cover = useRef<HTMLImageElement>(null);
  const [hasCover, setHasCover] = useState(true);

  useEffect(() => {
    // An image that failed before hydration never reports it to React, so ask it directly.
    const image = cover.current;
    if (image?.complete && image.naturalWidth === 0) setHasCover(false);
  }, []);

  return (
    <section id="walkthrough" className="zx-film" data-cue="down" aria-labelledby="zx-film-title">
      <div className="zx-wrap">
        <header className="zx-section-head">
          <h2 id="zx-film-title" className="zx-h2">
            One guest&rsquo;s evening, in two and a half minutes.
          </h2>
          <p className="zx-section-head__lead">
            Eleanor signs up, gets her tickets by email and walks in with no signal. Captioned, so it works on
            mute.
          </p>
        </header>

        <button
          type="button"
          className="zx-film__cover"
          onClick={openFilm}
          aria-label={`Play the walkthrough, ${WALKTHROUGH_LENGTH}`}
        >
          {hasCover ? (
            // eslint-disable-next-line @next/next/no-img-element -- may be absent until committed; next/image would 404 noisily
            <img ref={cover} src={MEDIA.thumbnail} alt="" onError={() => setHasCover(false)} loading="lazy" />
          ) : (
            <span className="zx-film__card" aria-hidden>
              <span className="zx-film__card-brand">
                <Mark className="zx-film__card-mark" />
                zetix
              </span>
              <span className="zx-film__card-title">
                From sign-up
                <br />
                to <em>the door.</em>
              </span>
            </span>
          )}
          <span className="zx-film__play" aria-hidden>
            <Play />
          </span>
          <span className="zx-film__length" aria-hidden>
            {WALKTHROUGH_LENGTH}
          </span>
        </button>
      </div>
    </section>
  );
}
