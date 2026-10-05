import { Music4 } from 'lucide-react';

import { HAS_MARK } from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * One half of the torn ticket on a 64 grid; the other half is this turned 180°. This is the
 * simplified cut for small sizes (wider tear, no offset) — `public/brand/zetix-favicon.svg`.
 */
const HALF = 'M10 9H54A6 6 0 0 1 60 15V37A5 5 0 0 0 55.82 39.25H28.11L50.11 19.25H8.18A5 5 0 0 0 4 17V15A6 6 0 0 1 10 9Z';

/**
 * The square in the sidebar header and on sign-in: the Zetix app icon where the product is
 * Zetix (`@/lib/brand`), otherwise the music glyph on the theme's primary. The icon keeps its
 * own ink and coral under every console theme; that neutrality is why those colours were chosen.
 */
export function BrandTile({ className, glyphClassName }: { className?: string; glyphClassName?: string }) {
  if (HAS_MARK) {
    // `size-full!`: a sidebar button sizes every <svg> inside it down to an icon (`[&_svg]:size-4`).
    return (
      <div className={cn('aspect-square shrink-0', className)}>
        <svg viewBox="0 0 64 64" role="img" aria-label="Zetix" className="size-full!">
          <rect width="64" height="64" rx="15" fill="#17151F" />
          <g transform="translate(32 32) scale(.74) translate(-32 -32)">
            <path fill="#F6F3EE" d={HALF} />
            <path fill="#FF6A4D" transform="rotate(180 32 32)" d={HALF} />
          </g>
        </svg>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'bg-primary text-primary-foreground flex aspect-square items-center justify-center rounded-lg',
        className,
      )}
    >
      <Music4 className={glyphClassName} />
    </div>
  );
}
