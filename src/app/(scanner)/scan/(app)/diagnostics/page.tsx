import type { Metadata } from 'next';
import { requireScannerUser } from '@/lib/auth/guards';
import { DeviceReport } from './device-report';

export const metadata: Metadata = { title: 'Device check' };

/**
 * What this particular handset can actually do.
 *
 * **This page exists because the things that decide the door cannot be tested
 * from CI, or from any machine we own.** Only the Chromium engine is installed
 * in the build environment, so an "iPhone" test there reproduces an iPhone's
 * metrics and never Safari's behaviour. Three questions matter and none of them
 * is answerable except on the real phone:
 *
 *  1. Does it vibrate? (No iPhone does — but which of the six are iPhones?)
 *  2. Is the tone audible, and does the ringer switch silence it?
 *  3. How fast does its camera actually decode a printed QR, in this light?
 *
 * Two of those need a human to answer, so this page asks. An usher opens it,
 * taps twice, answers two yes/no questions and sends the summary — thirty
 * seconds per handset, done wherever they are, no Mac and no device lab.
 *
 * The ushers carry a mix of Android and iPhone (context.md §6 question 7), and the
 * rehearsal is 18 Sep — one day before the concert. Running this a week earlier
 * makes the rehearsal a confirmation rather than a discovery.
 */
export default async function DiagnosticsPage() {
  const user = await requireScannerUser();
  return <DeviceReport operatorName={user.displayName ?? user.email} />;
}
