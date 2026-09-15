import { describe, expect, it } from 'vitest';
import {
  PORTAL_SECTION_IDS,
  portalIsUnlocked,
  sectionOrder,
  type PortalUnlockMode,
} from '@/lib/portal/sections';

/**
 * Which sections appear, to whom, and in what order (spec/v2.md §13.2, §13.3).
 *
 * These are the two rules `O` builds against, so they are pinned here rather
 * than left to be re-read off the page's JSX.
 */

describe('the section slot takes an ordering, not an append', () => {
  it('puts feedback last in §13.3 list order and first once the show is over', () => {
    /**
     * The one property that makes this a slot rather than a list of children:
     * feedback is item 6 of §13.3 and the first thing on the page at 11pm.
     * An append-only slot cannot say that, which is why `O` gets an ordering.
     */
    expect(sectionOrder(false)).not.toContain('feedback');
    expect(sectionOrder(true)[0]).toBe('feedback');
  });

  it('leads with the ticket before the show and collapses it to the end after', () => {
    expect(sectionOrder(false)[0]).toBe('ticket');
    expect(sectionOrder(true).at(-1)).toBe('ticket');
  });

  it('reserves the slots O fills, in both orders', () => {
    /**
     * `notes` and `wall` render nothing until `O` supplies their nodes. They are
     * named here so that `O` adds two components and changes no ordering — the
     * seam the handoff asked for.
     */
    for (const order of [sectionOrder(false), sectionOrder(true)]) {
      expect(order).toContain('notes');
      expect(order).toContain('wall');
      expect(order.indexOf('wall')).toBeGreaterThan(order.indexOf('notes'));
    }
  });

  it('names every declared section exactly once per order', () => {
    /**
     * A duplicate renders a section twice; an omission drops one silently. Both
     * are the kind of mistake that arrives with an edit to the arrays above and
     * survives review.
     */
    const after = sectionOrder(true);
    expect([...after].sort()).toEqual([...PORTAL_SECTION_IDS].sort());
    expect(new Set(after).size).toBe(after.length);

    const before = sectionOrder(false);
    expect(new Set(before).size).toBe(before.length);
    /** Before the show, the whole list except feedback. */
    expect([...before, 'feedback'].sort()).toEqual([...PORTAL_SECTION_IDS].sort());
  });
});

describe('unlock_mode answers who, never when', () => {
  const unlocked = (mode: PortalUnlockMode | null, admitted: boolean) =>
    portalIsUnlocked({ mode, admitted, cancelled: false });

  it('ON_ADMISSION requires a check-in', () => {
    expect(unlocked('ON_ADMISSION', false)).toBe(false);
    expect(unlocked('ON_ADMISSION', true)).toBe(true);
  });

  it('OPEN_TO_ALL is the one-click fallback and needs no scan', () => {
    /** For the night the door falls behind, so the booklet stays reachable (§13.2). */
    expect(unlocked('OPEN_TO_ALL', false)).toBe(true);
  });

  it('CLOSED is status page only, even for someone who was admitted', () => {
    expect(unlocked('CLOSED', true)).toBe(false);
  });

  it('locks when no level of the cascade supplies a mode', () => {
    expect(unlocked(null, true)).toBe(false);
  });

  it('never unlocks a cancelled ticket, whatever the mode', () => {
    for (const mode of ['ON_ADMISSION', 'OPEN_TO_ALL', 'CLOSED'] as const) {
      expect(portalIsUnlocked({ mode, admitted: true, cancelled: true })).toBe(false);
    }
  });
});
