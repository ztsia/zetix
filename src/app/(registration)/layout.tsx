import type { Metadata, Viewport } from 'next';

/**
 * The registration surface (spec/surfaces.md §15.2).
 *
 * **Single column, no chrome, orchestra branding.** There is no navigation
 * because there is nowhere to go: someone arrives on a link from an email or a
 * poster, fills in one form, and leaves. A header with links would offer them a
 * site that does not exist.
 *
 * `K` ships the layout; `M` ships the screens inside it — the form, the
 * confirmation, the edit screen, the closed and full states, and the
 * verification landing page.
 *
 * **Responsive, and read on a phone.** Not "mobile-first" in the scanner's
 * sense — a player may well fill this in on a laptop — but the phone is the
 * hard case, so the width below is a maximum rather than a target, and the
 * controls inside are sized for a thumb (`src/components/forms/form-field.tsx`).
 *
 * **Pinch-zoom stays**, as it does on the portal and unlike the scanner's,
 * which suppresses it so an usher's double-tap cannot zoom the viewfinder. The
 * opposite is right here: someone reading a consent line or a long description
 * on a small screen should be able to enlarge it.
 *
 * **No theme is forced.** The scanner forces dark to protect night vision over
 * an hour of camera use; someone filling in a form on their own phone is better
 * served by the theme they chose.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * `noindex`, restated here rather than inherited silently.
 *
 * The root layout already sets it, but this is a surface where it is
 * load-bearing twice over: a player's form URL carries their token, and
 * possession of that token is the credential (`ref.md` §7). Restating it means a
 * future change to the root layout cannot quietly publish a form — or a player's
 * link — to a search index.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function RegistrationSurfaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      {/*
        One column, centred, capped at a comfortable measure. `px-4` rather than
        a container query: this surface has exactly one layout at every width,
        and the only thing that changes is how much room is left beside it.
      */}
      <main className="mx-auto w-full max-w-xl px-4 py-10 sm:py-14">{children}</main>
    </div>
  );
}
