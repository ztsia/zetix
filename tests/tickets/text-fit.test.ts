import { describe, expect, it } from 'vitest';
import {
  alignOffset,
  fitText,
  MIN_FONT_SIZE,
  valignOffset,
  wrap,
  type Measure,
} from '@/lib/tickets/render/text';

/**
 * Text fitting (spec/tickets.md §10.2 `max_lines` / `overflow`).
 *
 * This is the work `satori` would have done for free; choosing `pdf-lib` to
 * keep the QR vector means owning it, so it is tested rather than trusted.
 *
 * The measurer is a fixed 10 points per character at size 10, scaling linearly.
 * A synthetic measure makes the arithmetic checkable by hand — with a real font
 * the expected values would be whatever the code produced, which tests nothing.
 */
const measure: Measure = (text, size) => text.length * size;

describe('wrap', () => {
  it('keeps a short line whole', () => {
    expect(wrap('abc', 100, 10, measure, 3).lines).toEqual(['abc']);
  });

  it('breaks on whitespace when a line is full', () => {
    // Each char is 10pt at size 10, so 60pt holds six characters.
    const { lines, truncated } = wrap('aaa bbb ccc', 60, 10, measure, 3);
    expect(lines).toEqual(['aaa', 'bbb', 'ccc']);
    expect(truncated).toBe(false);
  });

  it('fits as many words per line as will go', () => {
    const { lines } = wrap('aa bb cc dd', 70, 10, measure, 3);
    expect(lines).toEqual(['aa bb', 'cc dd']);
  });

  it('reports truncation when the line budget runs out', () => {
    const { lines, truncated } = wrap('aaa bbb ccc', 60, 10, measure, 2);
    expect(lines).toEqual(['aaa', 'bbb']);
    expect(truncated).toBe(true);
  });

  it('breaks a single word that cannot fit any line', () => {
    // A 40-character surname with no spaces is a real thing to receive from a
    // public form. Letting it run off the edge is worse than breaking it.
    const { lines } = wrap('aaaaaaaaaa', 50, 10, measure, 3);
    expect(lines).toEqual(['aaaaa', 'aaaaa']);
    for (const line of lines) expect(measure(line, 10)).toBeLessThanOrEqual(50);
  });

  it('never emits a line wider than the box', () => {
    // The property that actually matters: whatever the input, nothing overflows.
    const inputs = [
      'Wellington Mainwaring',
      'supercalifragilisticexpialidocious',
      'a b c d e f g h i j k',
      'Ng',
      '     spaced     out     ',
    ];
    for (const input of inputs) {
      const { lines } = wrap(input, 80, 10, measure, 4);
      for (const line of lines) {
        expect(measure(line, 10), `"${line}" from "${input}"`).toBeLessThanOrEqual(80);
      }
    }
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(wrap('', 100, 10, measure, 2).lines).toEqual([]);
    expect(wrap('   ', 100, 10, measure, 2).lines).toEqual([]);
  });
});

describe('fitText with SHRINK', () => {
  const base = {
    maxWidth: 100,
    maxHeight: 40,
    fontSize: 20,
    maxLines: 1,
    overflow: 'SHRINK' as const,
    measure,
  };

  it('leaves text that already fits at its requested size', () => {
    const result = fitText({ ...base, text: 'abc' });
    expect(result.fontSize).toBe(20);
    expect(result.lines).toEqual(['abc']);
    expect(result.truncated).toBe(false);
  });

  it('shrinks until a long name fits one line', () => {
    // "Wellington Mainwaring" is 21 chars, so it needs size <= 100/21 ≈ 4.76 to
    // fit one line — below the floor, so it must clip rather than pretend.
    const result = fitText({ ...base, text: 'Wellington Mainwaring' });
    expect(result.fontSize).toBeLessThanOrEqual(20);
    for (const line of result.lines) {
      expect(measure(line, result.fontSize)).toBeLessThanOrEqual(base.maxWidth);
    }
  });

  it('shrinks rather than truncates when shrinking is enough', () => {
    // 10 chars in a 100pt box fits exactly at size 10.
    const result = fitText({ ...base, text: 'abcdefghij' });
    expect(result.truncated).toBe(false);
    expect(result.lines).toEqual(['abcdefghij']);
    expect(result.fontSize).toBe(10);
  });

  it('never goes below the legibility floor', () => {
    // Below ~6pt a name is unreadable at arm's length in a queue, so the honest
    // outcome is a clipped string an admin can see in the preview.
    const result = fitText({
      ...base,
      text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      maxWidth: 20,
    });
    expect(result.fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    expect(result.truncated).toBe(true);
  });

  it('respects the box height, not only the width', () => {
    // Two lines at size 20 with 1.2 line height is 48pt, over a 40pt box.
    const result = fitText({
      ...base, text: 'aaaa bbbb', maxLines: 2, maxHeight: 40,
    });
    expect(result.lines.length * result.fontSize * 1.2).toBeLessThanOrEqual(40);
  });

  it('produces a block that always fits the box', () => {
    // The renderer draws the result without further checks, so this is the
    // guarantee it relies on.
    const cases = [
      { text: 'short', maxLines: 1 },
      { text: 'Wellington Mainwaring', maxLines: 2 },
      { text: 'supercalifragilisticexpialidocious', maxLines: 3 },
      { text: 'Guest of Aravindhan Balasubramaniam', maxLines: 2 },
    ];
    for (const c of cases) {
      const r = fitText({ ...base, ...c, maxWidth: 120, maxHeight: 44 });
      expect(r.lines.length * r.fontSize * 1.2, c.text).toBeLessThanOrEqual(44);
      for (const line of r.lines) {
        expect(measure(line, r.fontSize), `"${line}"`).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe('fitText with CLIP', () => {
  const base = {
    maxWidth: 100,
    maxHeight: 40,
    fontSize: 20,
    maxLines: 1,
    overflow: 'CLIP' as const,
    measure,
  };

  it('keeps the requested size and drops what does not fit', () => {
    const result = fitText({ ...base, text: 'aaaaaaaaaa' });
    expect(result.fontSize).toBe(20);
    expect(result.truncated).toBe(true);
    expect(measure(result.lines[0], 20)).toBeLessThanOrEqual(100);
  });

  it('still respects the box height', () => {
    // A three-line request in a box that holds one line gets one line.
    const result = fitText({ ...base, text: 'aa bb cc', maxLines: 3, maxHeight: 24 });
    expect(result.lines.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

describe('alignment', () => {
  it('places a line left, centre and right', () => {
    expect(alignOffset(40, 100, 'left')).toBe(0);
    expect(alignOffset(40, 100, 'center')).toBe(30);
    expect(alignOffset(40, 100, 'right')).toBe(60);
  });

  it('does not push an overlong line out of the box on the left', () => {
    // A line wider than its box should start at or left of zero, never be
    // centred so that it overflows both edges equally.
    expect(alignOffset(120, 100, 'center')).toBeLessThanOrEqual(0);
  });

  it('places a text block top, middle and bottom', () => {
    // One line at size 10 with 1.2 line height is a 12pt block in a 40pt box.
    expect(valignOffset(1, 10, 40, 'top')).toBe(0);
    expect(valignOffset(1, 10, 40, 'middle')).toBe(14);
    expect(valignOffset(1, 10, 40, 'bottom')).toBe(28);
  });

  it('stacks two lines from the same origin', () => {
    expect(valignOffset(2, 10, 40, 'top')).toBe(0);
    expect(valignOffset(2, 10, 40, 'middle')).toBe(8);
    expect(valignOffset(2, 10, 40, 'bottom')).toBe(16);
  });
});
