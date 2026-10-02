'use client';

import { useLayoutEffect } from 'react';

/**
 * The portal follows the device's dark mode (spec/v3.md §32.3).
 *
 * Dark mode in this app is class-based (`globals.css`), and nothing set the
 * class on this surface, so a guest whose phone is dark got a white page at
 * full brightness in a dark hall. `PORTAL_PRE_PAINT` applies the device's
 * choice before the first paint; this keeps it in step if the phone switches,
 * and takes it off again as the portal unmounts so a client-side navigation
 * never carries it elsewhere. The QR keeps its own light plate either way.
 */
export function PortalTheme() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.classList.toggle('dark', query.matches);
      root.style.colorScheme = query.matches ? 'dark' : 'light';
    };
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
      root.classList.remove('dark');
      root.style.colorScheme = '';
    };
  }, []);
  return null;
}

/** Runs before hydration, so a dark phone never flashes a white page. */
export const PORTAL_PRE_PAINT = `(function(){try{var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
