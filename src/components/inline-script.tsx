'use client';

/**
 * A script that runs as the browser parses the server's HTML, before paint,
 * and is inert on the client — the pattern in Next's "Preventing flash before
 * hydration" guide (`node_modules/next/dist/docs/01-app/02-guides/`).
 *
 * On the server it is `text/javascript`, so a full page load runs it. On the
 * client it renders as `text/plain`: React never executes a script it
 * renders, and would warn in development that one was there.
 * `suppressHydrationWarning` accepts the type differing between the two.
 * Client-side navigations get the same effect from the component that owns
 * the state.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
