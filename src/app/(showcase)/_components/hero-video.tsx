'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useReducedMotion } from 'motion/react';
import { Pause, Play } from 'lucide-react';
import { MEDIA } from '../_lib/content';
import ticketShot from '../../../../docs/screenshots/ticket-light.png';
import scannerShot from '../../../../docs/screenshots/scanner-search.png';

/** `still`: the browser cannot play H.264, so the poster stays. `missing`: the files are not there. */
type State = 'waiting' | 'playing' | 'paused' | 'still' | 'missing';

/**
 * The silent hero loop (spec/v3.md §31): the 16:9 cut, or the 4:5 one on a phone. Its ground is
 * the brand's ink, so it bleeds into the page with no frame, and its poster sits behind it as the
 * box's background until the first frame arrives.
 *
 * Started from script rather than `autoplay`, so someone who asked for reduced motion gets the
 * poster and a play button instead of a moving picture; and it can always be paused, because it
 * loops for longer than five seconds. `preload="none"` means nothing is fetched until play is asked
 * for, so a missing file always reports after the listeners are on. Until the final render is
 * committed to `public/showcase/`, it is missing on a fresh deployment, and two of the demo's
 * screens stand in.
 */
export function HeroVideo() {
  const video = useRef<HTMLVideoElement>(null);
  const reduce = useReducedMotion();
  const [state, setState] = useState<State>('waiting');

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const source = element.querySelector('source:last-of-type');
    // A failed play also fires `pause`, which must not paper over why it failed.
    const settle = (next: State) => setState((current) => (current === 'missing' || current === 'still' ? current : next));
    const onPlay = () => settle('playing');
    const onPause = () => settle('paused');
    // The browser tries each <source> in turn; only the last one failing means there is nothing.
    // A browser without H.264 never fetches them at all, and keeps the poster instead.
    const onMissing = () => setState(element.canPlayType('video/mp4; codecs="avc1.640028"') ? 'missing' : 'still');
    element.addEventListener('playing', onPlay);
    element.addEventListener('pause', onPause);
    source?.addEventListener('error', onMissing);
    // React sets `muted` as a property after hydration, not as an attribute, and nothing autoplays
    // with sound, so it is set before asking.
    element.muted = true;
    if (!reduce) element.play().catch(() => undefined);
    return () => {
      element.removeEventListener('playing', onPlay);
      element.removeEventListener('pause', onPause);
      source?.removeEventListener('error', onMissing);
    };
  }, [reduce]);

  if (state === 'missing') {
    return (
      <div className="zx-hero__media zx-hero__media--still">
        <div className="zx-hero__still">
          <div className="zx-phone zx-hero__still-left">
            <div className="zx-phone__screen">
              <Image src={ticketShot} alt="A guest's ticket page with her QR code" sizes="260px" />
            </div>
          </div>
          <div className="zx-phone zx-hero__still-right">
            <div className="zx-phone__screen">
              <Image src={scannerShot} alt="The door scanner's search on an usher's phone" sizes="260px" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // From the video's own state only: the reduced-motion preference is known on the client's first
  // render but not on the server's, so anything drawn from it would not hydrate.
  const showPause = state === 'playing';
  return (
    <div className="zx-hero__media" data-state={state}>
      <video
        ref={video}
        className="zx-hero__video"
        muted
        loop
        playsInline
        preload="none"
        aria-label="A guest registers her party on her phone, gets her tickets by email, and is admitted at the door with no signal."
      >
        <source src={MEDIA.heroPortrait} type="video/mp4" media="(max-width: 767px)" />
        <source src={MEDIA.hero} type="video/mp4" />
      </video>
      <button
        type="button"
        className="zx-hero__toggle"
        hidden={state === 'still'}
        aria-label={showPause ? 'Pause the loop' : 'Play the loop'}
        onClick={() => {
          const element = video.current;
          if (!element) return;
          if (showPause) element.pause();
          else element.play().catch(() => undefined);
        }}
      >
        {showPause ? <Pause aria-hidden /> : <Play aria-hidden />}
      </button>
    </div>
  );
}
