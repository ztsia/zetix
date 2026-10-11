import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { PhoneScreen, type Screen } from '../../../_components/phone-screen';
import { TICKET_CODE } from '../../../_lib/guest';
import { isShowcase } from '../../../_lib/flag';
import { qrPath } from '../../../_lib/qr';

/**
 * One of the guest's pages, as the landing page's phones run it (`live-phone.tsx`), in a frame of
 * its own. A frame because the portal's components size themselves by the window (`sm:` and
 * `md:`), and inside the landing page the window is a desktop's: the stars of a rating wrap and the
 * inputs shrink. Here the window is the phone's 390 px, so every one of them is as on a phone.
 *
 * Like the landing page, a 404 wherever `SHOWCASE` is not set.
 */
const SCREENS: readonly Screen[] = ['ticket', 'after'];

export function generateStaticParams() {
  return SCREENS.map((screen) => ({ screen }));
}

export const dynamicParams = false;

export const metadata: Metadata = {
  title: 'Zetix · A guest’s page',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function PhoneScreenPage({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  if (!isShowcase() || !SCREENS.includes(screen as Screen)) notFound();
  // Eleanor's ticket: the QR her page shows is the one the door admits further down the page.
  const { path, size } = qrPath(TICKET_CODE);
  const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
  return <PhoneScreen screen={screen as Screen} qr={qr} />;
}
