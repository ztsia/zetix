import type { Metadata } from 'next';
import { requireScannerUser } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: { default: 'Door scanner', template: '%s — Door scanner' },
};

/**
 * The signed-in half of the scanner surface (spec/surfaces.md §15.4).
 *
 * `/scan/login` sits outside this route group deliberately: a guard that also
 * covered the login page would redirect it to itself.
 *
 * Module `G` builds the bottom tab navigation, the camera and the attendee
 * sheet inside here. F2 supplies the boundary and the show list.
 */
export default async function ScannerAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireScannerUser();
  return <div className="flex min-h-svh flex-col">{children}</div>;
}
