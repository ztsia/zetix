'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import Lenis from 'lenis';
import { DemoDialog, type DemoAccess } from './demo-dialog';
import { FilmDialog } from './film-dialog';

/**
 * The house lights. Every section names its own (`data-cue`), and whichever one crosses the middle
 * of the viewport sets the whole page: ink for the overture and the night, paper for the work in
 * between, the way the film lights its chapters. One cue for the room, not a colour per section, so
 * it reads as lighting rather than as stripes.
 */
export type Lights = 'down' | 'dark' | 'up';

type Showcase = { openFilm: () => void; openDemo: () => void };

const ShowcaseContext = createContext<Showcase | null>(null);

export function useShowcase(): Showcase {
  const value = useContext(ShowcaseContext);
  if (!value) throw new Error('useShowcase() outside <ShowcaseRoot>');
  return value;
}

export function ShowcaseRoot({ demo, children }: { demo: DemoAccess; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [lights, setLights] = useState<Lights>('down');
  const [film, setFilm] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);

  useEffect(() => {
    const sections = root.current?.querySelectorAll<HTMLElement>('[data-cue]');
    if (!sections?.length) return;
    // A zero-height line across the middle of the viewport: the section on it has the room.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cue = (entry.target as HTMLElement).dataset.cue as Lights | undefined;
          if (entry.isIntersecting && cue) setLights(cue);
        }
      },
      { rootMargin: '-50% 0px -50% 0px' },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  // Smooth scrolling for the wheel, which the programme's scroll-driven stage reads as a gesture
  // rather than as steps. Lenis honours reduced motion on its own (it tracks the wheel 1:1 then),
  // leaves touch native, and is gone when this page unmounts, so no other surface has it.
  const lenis = useRef<Lenis | null>(null);
  useEffect(() => {
    const instance = new Lenis({ autoRaf: true, anchors: { offset: -76 } });
    lenis.current = instance;
    return () => {
      instance.destroy();
      lenis.current = null;
    };
  }, []);
  // A dialog has its own scroll, and the page behind it must not move.
  useEffect(() => {
    if (film || demoOpen) lenis.current?.stop();
    else lenis.current?.start();
  }, [film, demoOpen]);

  const openFilm = useCallback(() => setFilm(true), []);
  const openDemo = useCallback(() => setDemoOpen(true), []);
  const value = useMemo(() => ({ openFilm, openDemo }), [openFilm, openDemo]);

  return (
    <MotionConfig reducedMotion="user">
      <ShowcaseContext.Provider value={value}>
        <div ref={root} className="zx" data-lights={lights}>
          {children}
          <FilmDialog open={film} onClose={() => setFilm(false)} />
          <DemoDialog open={demoOpen} onClose={() => setDemoOpen(false)} demo={demo} />
        </div>
      </ShowcaseContext.Provider>
    </MotionConfig>
  );
}
