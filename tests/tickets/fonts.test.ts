import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { allFaceKeys, loadFace, resolveFace, type FaceKey } from '@/lib/tickets/fonts';

/**
 * The vendored faces are real, distinct, and embeddable.
 *
 * `spec/tickets.md` §10.4 requires embedded fonts because the render must match
 * the editor. Two failures are possible here and neither announces itself:
 *
 *  - **A missing or corrupt file** fails only in the render path, in production,
 *    on the day tickets go out.
 *  - **Two identical faces.** Google Fonts sometimes serves one variable font
 *    for several weights. The ticket still renders; the name is simply not bold,
 *    and shrink-to-fit measures the wrong metrics. That looks like success.
 *
 * So this measures the same string in every face and requires the widths to
 * differ, rather than trusting three distinct filenames to mean three faces.
 */

/** Wide, mixed-width, and long enough that face differences exceed rounding. */
const PROBE = 'Wellington Mainwaring';

async function embed(key: FaceKey) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  return doc.embedFont(loadFace(key), { subset: true });
}

describe('the vendored ticket fonts', () => {
  it('reads every registered face off disk', () => {
    for (const key of allFaceKeys()) {
      const bytes = loadFace(key);
      expect(bytes.byteLength, `${key} is empty`).toBeGreaterThan(10_000);
      // TrueType files start with the version tag 0x00010000; a proxy error page
      // or an HTML 404 saved as .ttf would sail past a byte-length check alone.
      expect([...bytes.slice(0, 4)], `${key} is not TrueType data`).toEqual([0, 1, 0, 0]);
    }
  });

  it('embeds every face into a real PDF', async () => {
    for (const key of allFaceKeys()) {
      const font = await embed(key);
      expect(font.widthOfTextAtSize(PROBE, 22)).toBeGreaterThan(0);
    }
  });

  it('has no two faces that are secretly the same face', async () => {
    const widths = new Map<string, number>();
    for (const key of allFaceKeys()) {
      const font = await embed(key);
      widths.set(key, Number(font.widthOfTextAtSize(PROBE, 22).toFixed(3)));
    }
    const seen = new Map<number, string>();
    for (const [key, width] of widths) {
      const clash = seen.get(width);
      expect(
        clash,
        `${key} and ${clash} measure "${PROBE}" identically at ${width}pt — ` +
          'they are the same face. Re-fetch them separately; see ' +
          'src/assets/fonts/README.md.',
      ).toBeUndefined();
      seen.set(width, key);
    }
    expect(seen.size).toBe(allFaceKeys().length);
  });

  it('snaps an unvendored weight to the nearest one in the family', () => {
    // §10.2 lets a layout carry any numeric weight; only two are vendored.
    expect(resolveFace('Inter', 400)).toBe('Inter:400');
    expect(resolveFace('Inter', 600)).toBe('Inter:600');
    expect(resolveFace('Inter', 700)).toBe('Inter:600');
    expect(resolveFace('Inter', 300)).toBe('Inter:400');
    // Exactly between 400 and 600: resolves deterministically rather than by
    // iteration order, so a template renders the same way on every request.
    expect(resolveFace('Inter', 500)).toBe('Inter:400');
  });

  it('defaults to weight 400 when a layout omits one', () => {
    expect(resolveFace('Inter')).toBe('Inter:400');
    expect(resolveFace('JetBrains Mono')).toBe('JetBrains Mono:400');
  });

  it('refuses an unknown family rather than substituting one', () => {
    // The whole point of §10.4: a substituted face changes every metric, so
    // shrink-to-fit stops agreeing with the editor and overflow reaches paper.
    expect(() => resolveFace('Comic Sans MS')).toThrow(/No embedded font/);
    expect(() => resolveFace('')).toThrow(/No embedded font/);
  });
});
