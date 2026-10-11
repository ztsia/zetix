import { AUTHOR, DECISIONS_URL, REPO_URL } from '../_lib/content';
import { Mark, Wordmark } from './mark';

export function Footer() {
  return (
    <footer className="zx-footer" data-cue="down">
      <div className="zx-wrap zx-footer__row">
        <p className="zx-footer__brand">
          <Mark className="zx-footer__mark" />
          <Wordmark />
          <span className="zx-footer__tag">Ticketing for free concerts</span>
        </p>
        <nav aria-label="Elsewhere" className="zx-footer__links">
          <a href={REPO_URL}>GitHub</a>
          <a href={DECISIONS_URL}>Decisions</a>
          <a href={AUTHOR.url}>Made by {AUTHOR.name}</a>
        </nav>
      </div>
      <div className="zx-wrap">
        <p className="zx-footer__fine">
          The concert, the guests and every name on this page belong to the demo, and are fictional.
        </p>
      </div>
    </footer>
  );
}
