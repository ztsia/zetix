import 'server-only';

import QRCode from 'qrcode';
import { qrUrl } from '@/lib/tickets/identifiers';

/**
 * The same symbol the printed ticket carries, drawn for a screen.
 *
 * **Rendered to SVG on the server and inlined.** No client library, no image
 * request, no layout shift — about two kilobytes in the HTML, which matters on
 * the venue wifi this page is most likely to be opened on (spec/surfaces.md §15.3).
 *
 * Error correction `M` and a two-module quiet zone match the seeded template's
 * QR element (spec/tickets.md §10.2), so a guest holding up their phone presents
 * the door the same symbol as the paper it was cut from.
 */

/**
 * What goes inside the QR.
 *
 * Normally `https://{APP_URL}/t/{token}` — byte for byte what module `D` mints
 * into the PDF (§10.1), so screen and paper are interchangeable at the door.
 *
 * **With no usable `APP_URL` it falls back to the bare token** rather than
 * throwing, which is the one place this file departs from `loadTicket()`. That
 * function is right to refuse: a rendered PDF is unrecallable, so a bad origin
 * baked into it is permanent. This page is re-rendered on every request, its
 * worst case is a link that does not open, and the scanner accepts a bare token
 * as its first acceptance rule (§10.1 rule 2) — so degrading keeps a scannable
 * QR in the guest's hand where throwing would give them a 500.
 */
export function qrPayload(token: string): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return token;
  try {
    return qrUrl(token, appUrl);
  } catch {
    // A malformed or non-http APP_URL. Same reasoning as above: the door reads
    // the token either way, so a misconfigured origin must not cost the guest
    // their QR.
    return token;
  }
}

/**
 * The QR as an `<svg>` string, ready to inline.
 *
 * The library emits an opaque white background path under the modules, so the
 * symbol carries its own light plate whatever theme the page is painted in.
 * That is the screen form of §10.4's rendering constraint — a QR on a dark
 * surface is a QR that does not scan — and it is why this markup is never
 * themed.
 */
export async function qrSvg(token: string): Promise<string> {
  const svg = await QRCode.toString(qrPayload(token), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
  if (!svg.startsWith('<svg')) {
    // The output is inlined with `dangerouslySetInnerHTML`. Its only inputs are
    // our own origin and a base62 token that has already been shape-checked, so
    // this cannot fire on real input — it is here so that a library change that
    // wrapped the markup in anything else fails visibly rather than injecting.
    throw new Error('QR renderer did not return an <svg> element.');
  }
  return svg;
}
