'use client';

import { WALKTHROUGH_YOUTUBE_ID } from '../_lib/content';
import { Mark } from './mark';
import { Modal } from './modal';

/**
 * The walkthrough, on YouTube (spec/v3.md §31). The player is only requested once someone asks for
 * it: nothing from YouTube loads with the page. `youtube-nocookie` keeps it from setting cookies
 * until it is played.
 */
export function FilmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label="The walkthrough" panelClassName="zx-film-panel">
      {WALKTHROUGH_YOUTUBE_ID ? (
        <iframe
          className="zx-film-panel__player"
          src={`https://www.youtube-nocookie.com/embed/${WALKTHROUGH_YOUTUBE_ID}?autoplay=1&rel=0&playsinline=1`}
          title="Zetix: the walkthrough"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <div className="zx-film-panel__pending">
          <Mark className="zx-film-panel__mark" />
          <p className="zx-film-panel__title">The walkthrough isn&rsquo;t on YouTube yet.</p>
          <p className="zx-film-panel__note">
            The loop at the top of this page follows the same evening, without sound.
          </p>
        </div>
      )}
    </Modal>
  );
}
