import type { Metadata, Viewport } from 'next';
import { InlineScript } from '@/components/inline-script';
import { PORTAL_PRE_PAINT, PortalTheme } from './portal-theme';

/**
 * The concert portal surface (spec/surfaces.md §15.3).
 *
 * In V1 it holds exactly one screen — the read-only ticket status page at
 * `/t/{qr_token}` (spec/README.md §4.1). The full portal, unlocked on admission, is V2
 * (spec/v2.md §13); nothing here should grow toward it.
 *
 * **This layout deliberately keeps pinch-zoom**, unlike the scanner's, which
 * suppresses it so an usher's double-tap cannot zoom the viewfinder
 * (`src/app/(scanner)/layout.tsx`). The opposite is true here: the reader is a
 * guest holding their own phone, and enlarging the QR or the venue address is
 * exactly what they may want to do.
 *
 * **It follows the device's theme** (spec/v3.md §32.3). The scanner forces dark
 * to protect an usher's night vision; a ticket holder glancing at their own
 * phone is better served by the theme they chose — and a white page at full
 * brightness in a dark auditorium is what §15.3 warns against. The one thing
 * that must not follow the theme is the QR, which carries its own opaque light
 * plate (`src/lib/portal/qr.ts`).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * `noindex`, restated here rather than inherited silently.
 *
 * The root layout already sets it for the whole app, but this is the surface
 * where it is load-bearing: possession of the token is the credential
 * (spec/v2.md §13.3), and a token in a search index is a ticket handed to
 * whoever searches. Restating it means a future change to the root layout
 * cannot quietly expose this page.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PortalSurfaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <InlineScript html={PORTAL_PRE_PAINT} />
      <PortalTheme />
      {children}
    </div>
  );
}
