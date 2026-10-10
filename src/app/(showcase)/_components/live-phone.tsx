'use client';

import { useEffect, useRef, useState } from 'react';
import Image, { type StaticImageData } from 'next/image';
import { Hand } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The width the guest pages are laid out at, a phone's; the frame scales them to fit. */
const PAGE_WIDTH = 390;

/**
 * A phone running one of the guest's real pages, built from the portal's own components, so it can
 * be scrolled, tapped and filled in rather than looked at. The page is in a frame 390 px wide
 * (`/showcase/phone/[screen]`), scaled to the screen, so whatever in it sizes itself by the window
 * sees a phone's.
 *
 * It wakes on a tap. Until then the frame takes no pointer and no focus, so the wheel scrolls the
 * landing page and scrolling past a phone never gets caught inside it. Awake, the frame has the
 * wheel; the pointer moving back out onto the landing page puts it to sleep again (the page hears
 * nothing while the pointer is inside the frame, so any pointer it does hear outside the phone has
 * left it). The screenshot stands in behind the frame until the page is drawn.
 */
export function LivePhone({
  label,
  src,
  still,
  stillAlt,
  sizes,
  className,
}: {
  /** What the phone is showing, for the frame's title and its wake button. */
  label: string;
  src: string;
  still: StaticImageData;
  stillAlt: string;
  sizes: string;
  className?: string;
}) {
  const phone = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      element.style.setProperty('--zx-live-k', String(entry.contentRect.width / PAGE_WIDTH));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!awake) return;
    const away = (event: PointerEvent) => {
      if (event.type === 'pointermove' && event.pointerType !== 'mouse') return;
      if (!phone.current?.contains(event.target as Node)) setAwake(false);
    };
    document.addEventListener('pointermove', away);
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointermove', away);
      document.removeEventListener('pointerdown', away);
    };
  }, [awake]);

  return (
    <div ref={phone} className={cn('zx-phone zx-phone--shot zx-live', className)} data-awake={awake ? '' : undefined}>
      <div ref={screen} className="zx-phone__screen zx-live__screen">
        <Image src={still} alt={awake ? '' : stillAlt} sizes={sizes} className="zx-shot__img" placeholder="blur" />
        <iframe
          ref={frame}
          src={src}
          title={label}
          className="zx-live__frame"
          loading="lazy"
          tabIndex={awake ? 0 : -1}
          inert={!awake}
        />
      </div>
      {awake ? null : (
        <button
          type="button"
          className="zx-live__wake"
          aria-label={`Try it: ${label}`}
          onClick={() => {
            setAwake(true);
            frame.current?.contentWindow?.focus();
          }}
        >
          <span className="zx-live__pill">
            <Hand aria-hidden />
            Tap to try it
          </span>
        </button>
      )}
    </div>
  );
}
