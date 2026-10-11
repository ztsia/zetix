'use client';

import { Play } from 'lucide-react';
import { useShowcase } from './root';

export function HeroActions() {
  const { openDemo, openFilm } = useShowcase();
  return (
    <div className="zx-hero__actions">
      <button type="button" className="zx-btn zx-btn--primary" onClick={openDemo}>
        Open the demo
      </button>
      <button type="button" className="zx-btn zx-btn--ghost" onClick={openFilm}>
        <Play aria-hidden className="zx-btn__icon" />
        Watch the walkthrough
      </button>
    </div>
  );
}
