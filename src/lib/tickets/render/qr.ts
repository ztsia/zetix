import QRCode from 'qrcode';
import { rgb, type PDFPage } from 'pdf-lib';
import type { QrElement } from '../layout';

/**
 * Drawing the QR (spec/tickets.md §10.4).
 *
 * Drawn as **vector rectangles**, one per module, not as a rasterised image.
 * That is the whole reason this project renders with `pdf-lib` rather than
 * going through `satori` and `resvg`: a rasterised symbol has whatever module
 * edges the chosen DPI gives it, and softened edges on the one component that
 * must scan is a risk taken for no gain. Vector squares are exact at any print
 * size.
 */

/**
 * The opaque plate drawn under every QR, whatever the artwork behind it.
 *
 * §10.4 calls this a rendering constraint rather than a design preference, and
 * it is the difference between a ticket that scans and one that does not: a
 * busy or dark background under a QR defeats the contrast the decoder needs.
 * Near-white rather than pure white so the plate reads as part of the design on
 * a cream or off-white stock.
 */
const PLATE = rgb(1, 1, 1);
const MODULE = rgb(0, 0, 0);

export type QrGeometry = {
  /** Side of one module, in points. */
  moduleSize: number;
  /** Points from the element's edge to the first dark module. */
  quietZone: number;
  /** Modules across the symbol, excluding the quiet zone. */
  symbolModules: number;
};

/**
 * Where the modules fall inside the element's box.
 *
 * The element's `w`/`h` is the **whole** footprint including the quiet zone, so
 * a template that reserves 130pt gets a 130pt plate — what the editor shows is
 * what the paper gets, which is what makes §10.4's "the editor shows this plate
 * so the layout is honest about the space it takes" true.
 */
export function qrGeometry(symbolModules: number, element: QrElement): QrGeometry {
  const total = symbolModules + element.margin_modules * 2;
  const moduleSize = Math.min(element.w, element.h) / total;
  return {
    moduleSize,
    quietZone: moduleSize * element.margin_modules,
    symbolModules,
  };
}

/**
 * Draw the QR for `value` into `element`'s box.
 *
 * `x`/`y` are in pdf-lib's bottom-left space; the caller converts from the
 * layout's top-down coordinates, so exactly one place in the renderer does that
 * arithmetic.
 *
 * An empty `value` draws the plate and nothing else rather than throwing: an
 * attendee with no `qr_token` has not been minted yet, and a preview of an
 * unminted ticket is a legitimate thing to render.
 */
export async function drawQr(
  page: PDFPage,
  element: QrElement,
  value: string,
  origin: { x: number; y: number },
): Promise<QrGeometry | null> {
  const side = Math.min(element.w, element.h);

  // The plate goes down first and covers the full footprint, quiet zone
  // included — the quiet zone is only quiet if it is also light.
  page.drawRectangle({
    x: origin.x,
    y: origin.y,
    width: side,
    height: side,
    color: PLATE,
  });

  if (!value) return null;

  const qr = QRCode.create(value, { errorCorrectionLevel: element.ec_level });
  const symbolModules: number = qr.modules.size;
  const bits = qr.modules.data;
  const geometry = qrGeometry(symbolModules, element);
  const { moduleSize, quietZone } = geometry;

  for (let row = 0; row < symbolModules; row++) {
    for (let col = 0; col < symbolModules; col++) {
      if (!bits[row * symbolModules + col]) continue;
      page.drawRectangle({
        x: origin.x + quietZone + col * moduleSize,
        // The matrix runs top-down; the page runs bottom-up, so rows invert.
        y: origin.y + side - quietZone - (row + 1) * moduleSize,
        width: moduleSize,
        height: moduleSize,
        color: MODULE,
      });
    }
  }

  return geometry;
}
