import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractQrToken } from '@/lib/checkin/token';
import { qrPayload, qrSvg } from '@/lib/portal/qr';
import { qrUrl } from '@/lib/tickets/identifiers';

/**
 * The QR this page draws (spec/tickets.md §10.1, spec/README.md §4.1).
 *
 * Two properties matter, and only one of them is about pixels:
 *
 * 1. **Screen and paper carry the same payload**, so a guest who left the PDF
 *    at home presents the door the symbol it already expects.
 * 2. **Whatever is encoded, the door gets the token back.** That is checked
 *    against `extractQrToken()` itself — the scanner's own reader, not a
 *    restatement of it — so the fallback path is proved rather than asserted.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const APP_URL = 'https://zetix.vercel.app';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.APP_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved;
});

describe('what goes inside the QR', () => {
  it('is byte for byte what module D bakes into the PDF', () => {
    process.env.APP_URL = APP_URL;
    expect(qrPayload(TOKEN)).toBe(qrUrl(TOKEN, APP_URL));
    expect(qrPayload(TOKEN)).toBe(`${APP_URL}/t/${TOKEN}`);
  });

  it('falls back to the bare token rather than throwing when APP_URL is absent', () => {
    // `loadTicket()` is right to throw here: a rendered PDF is unrecallable. A
    // page is re-rendered every request, so the guest keeps a scannable QR.
    delete process.env.APP_URL;
    expect(qrPayload(TOKEN)).toBe(TOKEN);
  });

  it('falls back rather than throwing on an APP_URL that is not a URL', () => {
    process.env.APP_URL = 'zetix.vercel.app';
    expect(qrPayload(TOKEN)).toBe(TOKEN);
    process.env.APP_URL = 'ftp://zetix.vercel.app';
    expect(qrPayload(TOKEN)).toBe(TOKEN);
  });

  it('yields the token back through the scanner s own extractor, on every path', () => {
    // The property the fallback rests on (§10.1 rule 2). If this ever fails,
    // the page is drawing a QR the door cannot read.
    for (const value of [APP_URL, 'https://an-old-domain.example.org', undefined]) {
      if (value === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = value;
      expect(extractQrToken(qrPayload(TOKEN))).toBe(TOKEN);
    }
  });

  it('presents a per-deployment hostname rather than quietly correcting it', () => {
    /**
     * §10.1 Rule A bans `<project>-<hash>-<scope>.vercel.app` as an origin, and
     * this page deliberately does **not** enforce it a second time.
     *
     * The check belongs where a mistake is permanent: `loadTicket()` refuses to
     * render a PDF against one, because that PDF cannot be recalled. Here the
     * only correct behaviour is to agree with whatever the ticket says — if
     * `APP_URL` is wrong the tickets are already wrong, and a page silently
     * showing a *different* payload would hide that from the one gate designed
     * to catch it, the printed-ticket scan before the first blast (Rule C,
     * rule 6).
     *
     * It costs nothing at the door either way: the scanner never dereferences
     * the URL (decision 28), so the token still comes back out.
     */
    process.env.APP_URL = 'https://zetix-abc123-team.vercel.app';
    expect(qrPayload(TOKEN)).toBe(`https://zetix-abc123-team.vercel.app/t/${TOKEN}`);
    expect(extractQrToken(qrPayload(TOKEN))).toBe(TOKEN);
  });
});

describe('the inlined SVG', () => {
  beforeEach(() => {
    process.env.APP_URL = APP_URL;
  });

  it('is a self-contained svg element with no script in it', async () => {
    const svg = await qrSvg(TOKEN);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<script');
    // Nothing fetchable: this page loads on venue wifi, and a symbol that
    // needed a round trip to paint would be the one thing on screen that fails
    // exactly where it is needed. (The `xmlns` URI is a namespace name, never
    // dereferenced, which is why it is not what this asserts on.)
    expect(svg).not.toMatch(/<image\b|xlink:href|url\(/);
  });

  it('carries its own opaque light plate, so it survives a dark theme', async () => {
    // spec/tickets.md §10.4's rendering constraint, applied to a screen.
    const svg = await qrSvg(TOKEN);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#000000"');
  });

  it('draws the symbol the payload actually needs, quiet zone included', async () => {
    // Ties the markup to the payload rather than to a remembered number: the
    // viewBox must be the real module count plus two modules of quiet zone
    // each side, matching the seeded template's QR element (§10.2).
    const symbol = QRCode.create(qrPayload(TOKEN), { errorCorrectionLevel: 'M' });
    const expected = symbol.modules.size + 4;
    const svg = await qrSvg(TOKEN);
    expect(svg).toContain(`viewBox="0 0 ${expected} ${expected}"`);
  });

  it('scales to its container rather than pinning a pixel size', async () => {
    // The card sizes it; a width attribute here would fight that on a phone.
    const svg = await qrSvg(TOKEN);
    expect(svg).not.toMatch(/<svg[^>]*\swidth="/);
  });
});
