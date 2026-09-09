import type { Viewport } from 'next';

/**
 * The door scanner surface (spec/surfaces.md §15.4).
 *
 * This layout exists for two things that are properties of the *surface*
 * rather than of any screen inside it, and that the root layout must not carry
 * because the admin console shares it.
 *
 * **`viewportFit: 'cover'`** lets the camera run edge to edge, and is what makes
 * `env(safe-area-inset-*)` report anything other than zero. Without it an
 * iPhone renders the page inside the safe area already, the insets are all `0`,
 * and the bottom tab bar sits above a letterboxed strip instead of filling the
 * screen. With it, the page owns the full display and this layout owes the
 * notch and the home indicator their padding — which is why every edge below is
 * paid explicitly.
 *
 * **`userScalable: false` with `maximumScale: 1`.** Disabling zoom is normally
 * hostile and it is deliberate here: the operator is holding a phone one-handed
 * with a queue in front of them, and a double-tap that lands slightly off
 * "Admit remaining 3" must not zoom the viewfinder. It is scoped to this
 * surface. The admin console keeps pinch-zoom.
 *
 * iOS ≥ 10 ignores `user-scalable=no` for accessibility, so this does not
 * actually trap a user who needs to zoom — which is the right outcome. The
 * declaration still suppresses the *double-tap* and the focus-zoom on iOS, and
 * is honoured outright on Android.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
};

/**
 * **The scanner is dark, always, regardless of the viewer's theme.**
 *
 * Not a stylistic preference. This screen is read in a dim foyer, and a
 * full-bleed white UI at arm's length wrecks the operator's night vision and
 * washes out the one signal that has to carry admission on its own: the
 * full-screen colour flash (spec/checkin.md §12.2). Green, amber and red all
 * separate further against near-black than against white.
 *
 * It also costs less battery on the OLED panels most of these phones have, over
 * an hour of continuous camera use.
 *
 * `.dark` is a class variant in `globals.css`, so scoping it to this element
 * confines it to the scanner and leaves the admin console alone.
 */
export default function ScannerSurfaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="dark bg-background text-foreground">{children}</div>;
}
