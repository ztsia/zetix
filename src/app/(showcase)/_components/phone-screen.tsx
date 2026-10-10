'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { GUEST_LINKS, GuestAfter, GuestTicket } from './guest-pages';

export type Screen = 'ticket' | 'after';

const noSubscribe = () => () => {};

/**
 * The inside of a landing-page phone (`/showcase/phone/[screen]`): one of the guest's pages, drawn
 * only in the browser, where today's date is known, so the static page and the first client render
 * agree. Links go nowhere: each says instead, at the foot of the screen, what it does in the real
 * portal.
 */
export function PhoneScreen({ screen, qr }: { screen: Screen; qr: string }) {
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), 2800);
    return () => window.clearTimeout(timer);
  }, [hint]);

  return (
    <div
      className="zx-phone-page bg-background text-foreground min-h-dvh"
      onClickCapture={(event) => {
        const link = (event.target as HTMLElement).closest('a');
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute('href') ?? '';
        const match = Object.keys(GUEST_LINKS).find((fragment) => href.includes(fragment));
        setHint(match ? GUEST_LINKS[match as keyof typeof GUEST_LINKS] : 'In the real portal, this opens a new page.');
      }}
    >
      {client ? screen === 'ticket' ? <GuestTicket qr={qr} /> : <GuestAfter /> : null}
      <p
        role="status"
        className="bg-foreground text-background pointer-events-none fixed inset-x-3 bottom-3 rounded-xl px-3 py-2.5 text-center text-sm transition-[opacity,translate] duration-200 data-[shown]:translate-y-0 data-[shown]:opacity-100 translate-y-2 opacity-0"
        data-shown={hint ? '' : undefined}
      >
        {hint}
      </p>
    </div>
  );
}
