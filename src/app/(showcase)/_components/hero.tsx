import { HeroActions } from './hero-actions';
import { HeroVideo } from './hero-video';
import { Perforation } from './perforation';

/**
 * Overture: the house lights are down. The headline sets, the perforation is punched under it, and
 * the silent loop plays beside it (spec/v3.md §31). Most people watching are on mute, so the loop
 * carries its own captions.
 */
export function Hero() {
  return (
    <section id="top" className="zx-hero" data-cue="down" aria-labelledby="zx-hero-title">
      <div className="zx-wrap zx-hero__grid">
        <div className="zx-hero__copy">
          <h1 id="zx-hero-title" className="zx-hero__title">
            <span className="zx-rise">
              <span>From sign-up</span>
            </span>{' '}
            <span className="zx-rise">
              <span>
                to <em>the door.</em>
              </span>
            </span>
          </h1>
          <Perforation className="zx-hero__perf" />
          <p className="zx-hero__lead">
            Open-source ticketing for free concerts, with a door that works offline. It ran an
            orchestra&rsquo;s concert in September 2026.
          </p>
          <HeroActions />
        </div>
        <HeroVideo />
      </div>
    </section>
  );
}
