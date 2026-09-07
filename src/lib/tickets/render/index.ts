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

export type RenderOptions = {
  layout: Layout;
  data: TicketData;
  background?: Background;
};

export type RenderResult = {
  pdf: Uint8Array;
  /**
   * Elements whose text had to be clipped. Not an error — the ticket is valid
   * and the door does not read it — but the admin preview should say so before
   * a whole show goes out with a truncated name.
   */
  truncated: string[];
};

export async function renderTicket(options: RenderOptions): Promise<RenderResult> {
  const { layout, data, background = { kind: 'NONE' } } = options;
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
    const font = await doc.embedFont(loadFace(key), { subset: true });
    fonts.set(key, font);
    return font;
  };

  const truncated: string[] = [];

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
      case 'IMAGE':
        // Nothing to embed without an asset loader, and the seeded defaults use
        // none. Skipped rather than failed: an unrenderable decoration must not
        // cost a guest their ticket.
        break;
      case 'TEXT': {
        const clipped = await drawText(page, element, data, pageHeight, embedFace);
        if (clipped) truncated.push(element.id);
        break;
      }
    }
  }

  return { pdf: await doc.save(), truncated };
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
