import portalShot from '../../../../docs/screenshots/portal-after.png';
import { LivePhone } from './live-phone';

/**
 * Encore: the lights come up after the door. The guest's page once the concert is over, running:
 * rate it, leave the players a note, read the wall.
 */
export function Encore() {
  return (
    <section id="encore" className="zx-encore" data-cue="up" aria-labelledby="zx-encore-title">
      <div className="zx-wrap zx-encore__grid">
        <div className="zx-encore__copy">
          <p className="zx-chapter">
            <span className="zx-chapter__name">Encore</span>
            <i className="zx-chapter__tempo">Con applauso</i>
          </p>
          <h2 id="zx-encore-title" className="zx-h2">
            Afterwards, the same page asks how it was.
          </h2>
          <p className="zx-encore__body">
            Each guest&rsquo;s ticket page turns into a feedback form, and a wall where they leave notes for
            the players.
          </p>
          <figure className="zx-encore__note">
            <blockquote>
              <p>Bravo to the second violins. The Serenade was beautiful.</p>
            </blockquote>
            <figcaption>A guest&rsquo;s note to the players, in the demo</figcaption>
          </figure>
        </div>
        <LivePhone
          className="zx-encore__phone"
          label="Eleanor's page after the open rehearsal: a feedback form, a note for the players, and the wall"
          still={portalShot}
          stillAlt="The guest's page after the open rehearsal: how was your afternoon, with five stars to choose from"
          sizes="(min-width: 1024px) 320px, 70vw"
          src="/showcase/phone/after"
        />
      </div>
    </section>
  );
}
