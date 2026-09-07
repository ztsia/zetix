/**
 * Fitting a string into a fixed box (spec/tickets.md §10.2's `max_lines` and
 * `overflow`).
 *
 * This is the work `satori` would have done, and it lives here because the
 * alternative rasterises the whole ticket — including the QR, which is the one
 * component that must stay crisp. The layout already supplies absolute
 * coordinates, so what is actually needed is narrow: wrap, shrink to fit, and
 * place vertically.
 *
 * Pure functions over a measuring callback rather than over a pdf-lib font, so
 * every rule here is testable without building a PDF.
 */

/** Measures a string at a size, in points. `PDFFont.widthOfTextAtSize`. */
export type Measure = (text: string, size: number) => number;

export type FitOptions = {
  text: string;
  maxWidth: number;
  maxHeight: number;
  fontSize: number;
  maxLines: number;
  overflow: 'SHRINK' | 'CLIP';
  measure: Measure;
  /** Multiple of font size between baselines. 1.2 is the usual text setting. */
  lineHeight?: number;
};

export type FitResult = {
  lines: string[];
  /** The size actually used, which SHRINK may have reduced. */
  fontSize: number;
  /** True when text was dropped — the caller may want to warn an admin. */
  truncated: boolean;
};

const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * The smallest size worth printing, in points.
 *
 * SHRINK must terminate somewhere, and below about 6pt a name is unreadable at
 * arm's length in a queue — at which point the honest outcome is a clipped
 * string the admin can see in the preview, rather than a line of type nobody
 * can read pretending to have fitted.
 */
export const MIN_FONT_SIZE = 6;

/**
 * Break text into at most `maxLines` lines that each fit `maxWidth`.
 *
 * Greedy, on whitespace. A single word longer than the box is broken
 * mid-character rather than allowed to overflow — a 40-character surname with
 * no spaces is a real thing to receive from a public form, and letting it run
 * off the edge is the one outcome worse than a hyphenless break.
 */
export function wrap(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: Measure,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [], truncated: false };

  const lines: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current) lines.push(current);
    current = '';
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (lines.length >= maxLines) return { lines, truncated: true };

    if (measure(word, fontSize) <= maxWidth) {
      current = word;
      continue;
    }

    /**
     * The word alone does not fit, so break it across lines by character.
     *
     * **Binary search for the cut, not a walk back from the end.** Stepping
     * down one character at a time re-measures a growing prefix on every step,
     * which is quadratic in the word and cubic once `SHRINK` retries it at each
     * font size. A QA pass measured 240 characters at 19s and 500 at 87s — on a
     * route that renders one ticket inside a serverless timeout. Names that
     * long are pathological, but they arrive from a public form and the failure
     * is a dead request rather than an ugly ticket.
     */
    let remainder = word;
    while (remainder && measure(remainder, fontSize) > maxWidth) {
      let low = 1;
      let high = remainder.length - 1;
      let cut = 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (measure(remainder.slice(0, mid), fontSize) <= maxWidth) {
          cut = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      lines.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut);
      if (lines.length >= maxLines) return { lines, truncated: true };
    }
    current = remainder;
  }

  pushCurrent();
  if (lines.length > maxLines) {
    return { lines: lines.slice(0, maxLines), truncated: true };
  }
  return { lines, truncated: false };
}

/**
 * Fit text into the box, shrinking or clipping as the element asks.
 *
 * SHRINK steps the size down until the text fits both the line budget and the
 * box height, stopping at {@link MIN_FONT_SIZE}. CLIP keeps the size and drops
 * what does not fit. Either way the result never exceeds the box — the caller
 * can draw it without further checks, which is the point: a renderer that has
 * to remember to clip is a renderer that will one day forget.
 */
export function fitText(options: FitOptions): FitResult {
  const {
    text,
    maxWidth,
    maxHeight,
    maxLines,
    overflow,
    measure,
    lineHeight = DEFAULT_LINE_HEIGHT,
  } = options;

  const trimmed = text.trim();
  if (!trimmed) return { lines: [], fontSize: options.fontSize, truncated: false };

  const linesFitHeight = (size: number, count: number) =>
    count * size * lineHeight <= maxHeight;

  if (overflow === 'CLIP') {
    const size = options.fontSize;
    const { lines, truncated } = wrap(trimmed, maxWidth, size, measure, maxLines);
    // Height still binds: a two-line box asked for three lines gets two.
    const allowed = Math.max(1, Math.floor(maxHeight / (size * lineHeight)));
    const kept = lines.slice(0, allowed);
    return { lines: kept, fontSize: size, truncated: truncated || kept.length < lines.length };
  }

  for (let size = options.fontSize; size >= MIN_FONT_SIZE; size -= 0.5) {
    const { lines, truncated } = wrap(trimmed, maxWidth, size, measure, maxLines);
    if (!truncated && lines.length > 0 && linesFitHeight(size, lines.length)) {
      return { lines, fontSize: size, truncated: false };
    }
  }

  // Nothing fits even at the floor: clip at the floor rather than print
  // something illegible, and report it so a preview can flag it.
  const { lines } = wrap(trimmed, maxWidth, MIN_FONT_SIZE, measure, maxLines);
  const allowed = Math.max(1, Math.floor(maxHeight / (MIN_FONT_SIZE * lineHeight)));
  return { lines: lines.slice(0, allowed), fontSize: MIN_FONT_SIZE, truncated: true };
}

/**
 * The x offset of one line inside its box, for the element's alignment.
 */
export function alignOffset(
  lineWidth: number,
  boxWidth: number,
  align: 'left' | 'center' | 'right',
): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  if (align === 'right') return boxWidth - lineWidth;
  return 0;
}

/**
 * The y offset of the first baseline from the **top** of the box.
 *
 * Layout coordinates run top-down (the editor's canvas); pdf-lib's page runs
 * bottom-up. Keeping this function in top-down space means exactly one place
 * converts between the two, which is the whole defence against a ticket that
 * renders upside down in the vertical axis only.
 */
export function valignOffset(
  lineCount: number,
  fontSize: number,
  boxHeight: number,
  valign: 'top' | 'middle' | 'bottom',
  lineHeight = DEFAULT_LINE_HEIGHT,
): number {
  const blockHeight = lineCount * fontSize * lineHeight;
  if (valign === 'middle') return (boxHeight - blockHeight) / 2;
  if (valign === 'bottom') return boxHeight - blockHeight;
  return 0;
}

export { DEFAULT_LINE_HEIGHT };
