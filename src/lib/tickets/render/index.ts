import 'server-only';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { interpolate, resolveBinding, type TicketData } from '../bindings';
import { loadFace, resolveFace, type FaceKey } from '../fonts';
import { type Layout, type RectElement, type TextElement } from '../layout';
import { drawQr } from './qr';
import {
  alignOffset,
  DEFAULT_LINE_HEIGHT,
  fitText,
  valignOffset,
} from './text';

/**
 * Rendering a layout to a PDF (spec/tickets.md §10.4).
 *
 * Always a PDF: it prints predictably and every phone opens it. Rendered **on
 * demand rather than stored**, to stay inside free storage limits — which is
 * exactly why §10.5 pins the template version and §10.6 flags a reissue. If
 * PDFs were stored at send time neither mechanism would be needed; because they
 * are not, the pinned pair is the only thing keeping the copy in someone's
 * inbox and the copy behind their portal link in agreement.
 *
 * Two background paths, one output:
 *
 *  - **PDF** — load the original and draw onto page 1, so vector artwork
 *    survives at full resolution.
 *  - **Image, or none** — a fresh page at the layout's canvas size.
 *
 * `sharp` is deliberately not in this path. pdf-lib embeds PNG and JPEG
 * directly, and §10.3 already restricts uploads to those plus PDF; normalising
 * an upload is an upload-time job (module `E`), once per template rather than
 * once per ticket on all four hundred.
 */

export type Background =
  | { kind: 'NONE' }
  | { kind: 'PDF'; bytes: Uint8Array }
  | { kind: 'IMAGE'; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' };

/**
 * Bytes for an `IMAGE` element's `src`, or null when the store has nothing
 * there.
 *
 * A callback rather than a direct import of the asset store, so this module
 * stays a pure function of its inputs and keeps being testable without a
 * filesystem, a bucket or a network (`bindings.ts` makes the same trade for
 * ticket data). A caller that passes none draws no images, which is what every
 * seeded default expects.
 */
export type AssetLoader = (
  src: string,
) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

export type RenderOptions = {
  layout: Layout;
  data: TicketData;
  background?: Background;
  loadAsset?: AssetLoader;
};

export type RenderResult = {
  pdf: Uint8Array;
  /**
   * Elements whose text had to be clipped. Not an error — the ticket is valid
   * and the door does not read it — but the admin preview should say so before
   * a whole show goes out with a truncated name.
   */
  truncated: string[];
  /**
   * Elements the renderer could not draw at all, as `id: reason`.
   *
   * Distinct from `truncated`, which is a ticket that printed imperfectly. This
   * is a ticket missing something the template asked for, and it must not be
   * silent: a QA pass found an `IMAGE` element producing an empty page with no
   * error and nothing reported, which looks identical to a template that never
   * had the element.
   */
  skipped: Record<string, string>;
};

export async function renderTicket(options: RenderOptions): Promise<RenderResult> {
  const { layout, data, background = { kind: 'NONE' }, loadAsset } = options;
  const { width_pt: width, height_pt: height } = layout.canvas;

  const doc =
    background.kind === 'PDF'
      ? await PDFDocument.load(background.bytes)
      : await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const page =
    background.kind === 'PDF' ? firstPage(doc) : doc.addPage([width, height]);

  if (background.kind === 'IMAGE') {
    const image =
      background.mime === 'image/png'
        ? await doc.embedPng(background.bytes)
        : await doc.embedJpg(background.bytes);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }

  /**
   * The page the artwork actually is, not the one the layout assumed.
   *
   * A PDF background carries its own page box, and §10.3 makes that box
   * authoritative. If the two disagree — a template edited after its artwork was
   * replaced — the coordinates must be read against the real page or every
   * element lands somewhere else. Using the page's own height here means the
   * top-down conversion below stays correct either way.
   */
  const pageHeight = page.getHeight();

  const fonts = new Map<FaceKey, PDFFont>();
  const embedFace = async (key: FaceKey): Promise<PDFFont> => {
    const cached = fonts.get(key);
    if (cached) return cached;
    /**
     * **`subset: false`, and it is not negotiable.**
     *
     * pdf-lib's subsetter drops glyph outlines. The PDF comes out structurally
     * perfect — right glyph ids, right positions, right widths, valid
     * `ToUnicode` — and the page renders mostly blank, because the outlines
     * those ids point at are empty. "Wellington Mainwaring" printed as
     * "ll g a war g", and every test in this module passed while it did.
     *
     * Text extraction still returns the correct string, so nothing short of
     * inspecting the embedded font program catches it. That is what
     * `tests/tickets/glyphs.test.ts` does, and it turns red if anyone sets this
     * back to `true` to reclaim the file size.
     *
     * The cost is real, and is why it was `true` to begin with: a ticket goes
     * from ~12KB to ~410KB, since the whole of Inter and JetBrains Mono is
     * embedded rather than the glyphs in use. That is still well inside
     * `email.max_attachment_mb`, but a merged batch
     * (`email.merge_attachments_above`) wants to dedupe the font programs
     * rather than carry one copy per ticket — noted for module `F`.
     */
    const font = await doc.embedFont(loadFace(key), { subset: false });
    fonts.set(key, font);
    return font;
  };

  const truncated: string[] = [];
  const skipped: Record<string, string> = {};

  for (const element of layout.elements) {
    switch (element.type) {
      case 'RECT':
        drawRect(page, element, pageHeight);
        break;
      case 'QR':
        await drawQr(page, element, resolveBinding('attendee.qr_url', data), {
          x: element.x,
          y: topDown(element.y, Math.min(element.w, element.h), pageHeight),
        });
        break;
      case 'IMAGE': {
        /**
         * Skipped rather than failed whenever the bytes cannot be had — an
         * unrenderable decoration must not cost a guest their ticket — but
         * **reported**, because a silently missing element is indistinguishable
         * from one that was never there.
         *
         * Every reason is reported separately: "no loader" (a caller that never
         * offered one), "not in the store" (a deleted asset) and "not a PNG or
         * JPEG" are three different problems, and one shared message would send
         * an admin looking in the wrong place.
         */
        if (!loadAsset) {
          skipped[element.id] = 'no asset loader was given to the renderer';
          break;
        }
        const asset = await loadAsset(element.src).catch(() => null);
        if (!asset) {
          skipped[element.id] = `the asset store has nothing at ${element.src}`;
          break;
        }
        if (asset.contentType !== 'image/png' && asset.contentType !== 'image/jpeg') {
          // pdf-lib embeds exactly these two. A PDF here would be artwork
          // someone picked as a decoration; it is not embeddable as an image.
          skipped[element.id] = `${element.src} is ${asset.contentType}, not a PNG or JPEG`;
          break;
        }
        const image =
          asset.contentType === 'image/png'
            ? await doc.embedPng(asset.bytes)
            : await doc.embedJpg(asset.bytes);
        page.drawImage(image, {
          x: element.x,
          y: topDown(element.y, element.h, pageHeight),
          width: element.w,
          height: element.h,
          rotate: degrees(element.rotation),
          opacity: element.opacity,
        });
        break;
      }
      case 'TEXT': {
        const clipped = await drawText(page, element, data, pageHeight, embedFace);
        if (clipped) truncated.push(element.id);
        break;
      }
    }
  }

  return { pdf: await doc.save(), truncated, skipped };
}

function firstPage(doc: PDFDocument): PDFPage {
  const [page] = doc.getPages();
  if (!page) {
    throw new Error(
      'The background PDF has no pages. §10.3 takes page 1 as the ticket artwork.',
    );
  }
  return page;
}

/**
 * Layout coordinates run top-down, like the editor's canvas; a PDF page runs
 * bottom-up. **This is the only place that converts**, deliberately — the
 * conversion appearing twice, with one of them wrong, is how a ticket ends up
 * mirrored in the vertical axis alone and nobody notices until it is printed.
 */
function topDown(y: number, h: number, pageHeight: number): number {
  return pageHeight - y - h;
}

function drawRect(page: PDFPage, element: RectElement, pageHeight: number): void {
  page.drawRectangle({
    x: element.x,
    y: topDown(element.y, element.h, pageHeight),
    width: element.w,
    height: element.h,
    rotate: degrees(element.rotation),
    color: element.fill ? hexToRgb(element.fill) : undefined,
    borderColor: element.stroke ? hexToRgb(element.stroke) : undefined,
    borderWidth: element.stroke ? element.stroke_width : undefined,
  });
}

async function drawText(
  page: PDFPage,
  element: TextElement,
  data: TicketData,
  pageHeight: number,
  embedFace: (key: FaceKey) => Promise<PDFFont>,
): Promise<boolean> {
  const value = element.binding
    ? resolveBinding(element.binding, data, { format: element.format })
    : interpolate(element.text ?? '', data, { format: element.format });

  if (!value.trim()) return false;

  const font = await embedFace(resolveFace(element.font_family, element.font_weight));
  const fit = fitText({
    text: value,
    maxWidth: element.w,
    maxHeight: element.h,
    fontSize: element.font_size,
    maxLines: element.max_lines,
    overflow: element.overflow,
    measure: (text, size) => font.widthOfTextAtSize(text, size),
  });

  const lineHeight = fit.fontSize * DEFAULT_LINE_HEIGHT;
  const blockTop = valignOffset(
    fit.lines.length,
    fit.fontSize,
    element.h,
    element.valign,
  );

  /**
   * Where the baseline sits inside its line box.
   *
   * `heightAtSize(size, { descender: false })` is the ascent, so centring the
   * glyph box in the line and then dropping to the baseline keeps text visually
   * inside its box rather than riding above it — which is what a naive
   * `y = lineTop + size` does, and it shows up as text that looks correct in
   * isolation and misaligned against a rule or a rectangle beside it.
   */
  const ascent = font.heightAtSize(fit.fontSize, { descender: false });
  const glyphHeight = font.heightAtSize(fit.fontSize);
  const baselineInLine = (lineHeight - glyphHeight) / 2 + ascent;

  // The box's bottom edge in page space. Text measures up from here rather than
  // down from the page top so that this, like every other element, goes through
  // `topDown()` — an inline `pageHeight - y - …` here would be a second
  // conversion, and the second one is the one that ends up wrong.
  const boxBottom = topDown(element.y, element.h, pageHeight);

  fit.lines.forEach((line, index) => {
    const lineTopFromBoxTop = blockTop + index * lineHeight;
    const baselineFromBoxTop = lineTopFromBoxTop + baselineInLine;
    page.drawText(line, {
      x: element.x + alignOffset(font.widthOfTextAtSize(line, fit.fontSize), element.w, element.align),
      y: boxBottom + element.h - baselineFromBoxTop,
      size: fit.fontSize,
      font,
      color: hexToRgb(element.color),
      rotate: degrees(element.rotation),
    });
  });

  return fit.truncated;
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
