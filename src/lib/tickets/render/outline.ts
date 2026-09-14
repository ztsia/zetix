import 'server-only';

import fontkit from '@pdf-lib/fontkit';
import { degrees, type Color, type PDFFont, type PDFPage } from 'pdf-lib';
import { loadFace, loadOutlineFace, type FaceKey } from '../fonts';

/**
 * Printing characters no embedded font has a glyph for (`spec/tickets.md` §10.4).
 *
 * A Chinese name came out as a row of `|x|` boxes: Inter and JetBrains Mono
 * carry no CJK, and a PDF reader cannot borrow a face from the machine it is
 * opened on, so it draws `.notdef` for every character it cannot find.
 *
 * **Why the glyphs are drawn rather than embedded.** The obvious fix is to embed
 * a CJK font. It costs 10MB *per ticket* here, because `subset: false` is not
 * negotiable in this renderer — pdf-lib's subsetter blanks glyph outlines, and
 * `tests/tickets/glyphs.test.ts` pins the whole font going in byte for byte. A
 * 2MB subset trades that for a coverage cliff exactly where rare characters
 * live, which is personal names. So the fallback face is used as a source of
 * *shapes*: each character is drawn as a vector path, the same way a logo is,
 * and only the handful on that ticket reach the file. A three-character name
 * costs about 4KB and the font never leaves the bundle.
 *
 * **The cost, stated plainly:** text drawn this way is artwork. It prints,
 * scans and photographs identically, but it cannot be selected or searched
 * inside a PDF reader. The ticket code and the QR are unaffected, and admission
 * matches on `qr_token` rather than on anything printed (§10.1).
 */

type FontkitFont = ReturnType<typeof fontkit.create>;

/**
 * `Path.scale` exists in fontkit and is not in `@pdf-lib/fontkit`'s typings,
 * which declare `toSVG()` alone.
 *
 * Narrowed here rather than cast to `any` at the call site, and checked at
 * runtime in {@link flipVertically}: a fontkit upgrade that drops the method
 * would otherwise print every ticket upside down, which is the kind of thing
 * that renders perfectly and is wrong.
 */
type ScalablePath = { scale(x: number, y: number): { toSVG(): string } };

function flipVertically(path: unknown): string {
  const scalable = path as Partial<ScalablePath>;
  if (typeof scalable.scale !== 'function') {
    throw new Error(
      'fontkit Path.scale() is missing, so a glyph outline cannot be flipped ' +
        'into SVG orientation. Without it every drawn glyph prints upside down.',
    );
  }
  return scalable.scale(1, -1).toSVG();
}

const parsed = new Map<string, FontkitFont>();

function parse(key: string, bytes: Uint8Array): FontkitFont {
  const cached = parsed.get(key);
  if (cached) return cached;
  const font = fontkit.create(Buffer.from(bytes));
  parsed.set(key, font);
  return font;
}

/** The fallback face, parsed once per process. */
function fallback(): FontkitFont {
  return parse('__fallback__', loadOutlineFace());
}

/**
 * True when the embedded face cannot draw every character in `text`.
 *
 * Checked per character rather than by script: a name is one string and may mix
 * `陈` with `Tan`, and the question is only ever "does this face have a glyph
 * for this codepoint".
 */
export function needsOutline(key: FaceKey, text: string): boolean {
  const font = parse(key, loadFace(key));
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    // Whitespace and control characters are not the question; every face has a
    // space, and a missing one would be a broken font rather than a missing
    // script.
    if (cp <= 0x20) continue;
    if (!font.hasGlyphForCodePoint(cp)) return true;
  }
  return false;
}

/** Characters the fallback cannot draw either — nothing can print these. */
export function unprintable(text: string): string[] {
  const font = fallback();
  const missing: string[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined || cp <= 0x20) continue;
    if (!font.hasGlyphForCodePoint(cp) && !missing.includes(char)) missing.push(char);
  }
  return missing;
}

/**
 * Everything the layout in `drawText` needs from a face, so that the two ways of
 * putting marks on the page — an embedded font and drawn outlines — are
 * interchangeable behind one shape. `fitText` already measures through a
 * callback, and this extends that to the drawing half: wrapping, shrink-to-fit,
 * alignment and baseline placement stay written once and stay identical.
 */
export type Typesetter = {
  widthOf(text: string, size: number): number;
  /** Baseline offset from the top of the glyph box. */
  ascentAt(size: number): number;
  /** Ascender to descender, for centring the box within its line. */
  heightAt(size: number): number;
  draw(
    page: PDFPage,
    line: string,
    options: { x: number; y: number; size: number; color: Color; rotation: number },
  ): void;
};

/** The ordinary path: a font embedded in the document. */
export function embeddedTypesetter(font: PDFFont): Typesetter {
  return {
    widthOf: (text, size) => font.widthOfTextAtSize(text, size),
    ascentAt: (size) => font.heightAtSize(size, { descender: false }),
    heightAt: (size) => font.heightAtSize(size),
    draw: (page, line, { x, y, size, color, rotation }) =>
      page.drawText(line, { x, y, size, font, color, rotate: degrees(rotation) }),
  };
}

/**
 * The fallback path: glyph outlines drawn as paths.
 *
 * `weight` is honoured by stroking the outline rather than by loading a second
 * face — a bold CJK font is another 10MB on disk for one visual step, and the
 * seeded template asks for 600 on exactly the element a name lands in
 * (§10.2). The stroke is set in font units because pdf-lib emits the line width
 * *after* its own scale, so a width in points would come out scaled by the font
 * size.
 */
export function outlineTypesetter(weight = 400): Typesetter {
  const font = fallback();
  const upem = font.unitsPerEm;
  const strokeEm = weight >= 600 ? 0.022 : 0;

  const advance = (text: string) =>
    font.layout(text).positions.reduce((sum, p) => sum + p.xAdvance, 0);

  return {
    widthOf: (text, size) => (advance(text) * size) / upem,
    ascentAt: (size) => (font.ascent * size) / upem,
    heightAt: (size) => ((font.ascent - font.descent) * size) / upem,
    draw: (page, line, { x, y, size, color, rotation }) => {
      const scale = size / upem;
      const run = font.layout(line);
      let penX = 0;

      run.glyphs.forEach((glyph, i) => {
        const position = run.positions[i];
        // Glyph outlines are y-up from the baseline; `drawSvgPath` flips y,
        // because SVG runs the other way. Pre-flipping here means the two
        // cancel and the glyph lands upright.
        const d = flipVertically(glyph.path);

        // An empty path is a space or an unmapped glyph: advancing without
        // drawing is exactly right, and `drawSvgPath('')` would emit an empty
        // fill rather than nothing.
        if (d) {
          page.drawSvgPath(d, {
            x: x + (penX + (position.xOffset ?? 0)) * scale,
            y: y + (position.yOffset ?? 0) * scale,
            scale,
            rotate: degrees(rotation),
            color,
            ...(strokeEm > 0
              ? { borderColor: color, borderWidth: strokeEm * upem * 0.01 }
              : {}),
          });
        }
        penX += position.xAdvance;
      });
    },
  };
}
