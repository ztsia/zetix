/**
 * Which sections the portal shows, to whom, and in what order
 * (spec/v2.md §13.2, §13.3).
 *
 * **This file is the seam module `O` mounts into.** It is deliberately data and
 * not JSX: the page owns how a section looks, this owns whether it appears and
 * where. `O` adds `portal_notes` and the public wall by filling in the two
 * section ids already reserved below and supplying their nodes — it does not
 * need to touch the page's layout, the unlock rule or the ordering, and it must
 * not rewrite them (`docs/modules-v2.md` §3).
 *
 * **The slot takes an ordering, not an append**, which is the whole reason it
 * is a list per phase rather than a render-in-place. Feedback is last in §13.3's
 * list and first on the page once the show is over — an append-only slot cannot
 * express that, and the module that discovered it would have rewritten the page
 * to say it.
 */

/**
 * §13.3's list, by id.
 *
 * `notes` and `wall` are declared here before `O` exists so that the ordering
 * below is complete and reviewable in one place. A section with no node simply
 * does not render, so naming them early costs nothing and means `O` changes one
 * file rather than three.
 */
export const PORTAL_SECTION_IDS = [
  'ticket',
  'booklet',
  'notes',
  'wall',
  'practical',
  'feedback',
] as const;

export type PortalSectionId = (typeof PORTAL_SECTION_IDS)[number];

/**
 * The order sections appear in, before and after the show is over.
 *
 * **Before** is §13.3's own numbering. **After** is §13.2's third row —
 * *"Feedback first, then notes until `portal.notes_close_at`, booklet,
 * practical info. The ticket collapses to a stub."*
 *
 * The ticket's stub sorts **last** once the show is over. §13.2 names feedback
 * first and does not say where the stub goes, so this is a call rather than a
 * quotation: nobody opens that link at 11pm to look at a QR they no longer need,
 * and the page's own header already carries the concert and the show. The stub
 * is kept rather than dropped because it is where "you were admitted at 7:42pm"
 * lives, and a guest who wants to check that should not have to find another
 * page for it.
 *
 * `wall` keeps its place behind `notes` in both orders: it is the public face of
 * the same section and reading it before writing one inverts what §13.4 is for.
 */
const ORDER: Record<'before' | 'after', readonly PortalSectionId[]> = {
  before: ['ticket', 'booklet', 'notes', 'wall', 'practical'],
  after: ['feedback', 'notes', 'wall', 'booklet', 'practical', 'ticket'],
};

/**
 * **`feedback` is absent from `before` on purpose**, and it is not the same
 * thing as the section being disabled. §13.2's second row says "no feedback
 * form" for an admitted guest whose show is still running: the question has no
 * answer yet. `portal.feedback_enabled` is the admin's separate question of
 * whether it ever appears.
 */
export function sectionOrder(showIsOver: boolean): readonly PortalSectionId[] {
  return showIsOver ? ORDER.after : ORDER.before;
}

/** `portal.unlock_mode`, resolved through the cascade — never read off the column (§2.2). */
export type PortalUnlockMode = 'ON_ADMISSION' | 'OPEN_TO_ALL' | 'CLOSED';

export function isUnlockMode(value: unknown): value is PortalUnlockMode {
  return value === 'ON_ADMISSION' || value === 'OPEN_TO_ALL' || value === 'CLOSED';
}

/**
 * **`unlock_mode` answers who, never when** (decision 39).
 *
 * It gates *who* may see the unlocked sections and nothing else. It is never
 * flipped by a show reaching `COMPLETED`: `CLOSED` means status page only, so
 * auto-flipping it on completion would take the feedback form down at the exact
 * moment every attendee is emailed a link to it, and the booklet with it. Each
 * section ends on its own lifecycle instead — `booklets.published`,
 * `portal.notes_close_at`, `portal.feedback_close_at`.
 *
 * - `ON_ADMISSION` — a `check_ins` row is required. The default, and what gets
 *   both things worth having: the booklet does not leak before the concert, and
 *   notes come only from people who actually attended.
 * - `OPEN_TO_ALL` — the one-click admin fallback for a night when door scanning
 *   falls behind or venue connectivity fails, so the booklet stays reachable.
 * - `CLOSED` — status page only.
 *
 * **An unresolved mode locks.** `portal.unlock_mode` carries no seed and no code
 * default — it is `operational` in the settings catalogue, so null means nobody
 * has configured this concert's portal yet, exactly as a null capacity means
 * nobody has configured the hall (spec/README.md §2.1). Locking is the right
 * direction to fail in: a booklet shown early cannot be un-shown once a stranger
 * has the PDF, while a booklet held back is one settings change away.
 *
 * A cancelled ticket never unlocks. §13.2 gives cancellation a terminal message
 * and sends the holder to the front desk; a cancelled party reading the booklet
 * is not harmful, but a page that says "no longer valid" above a full portal is
 * telling them two different things.
 */
export function portalIsUnlocked(input: {
  mode: PortalUnlockMode | null;
  admitted: boolean;
  cancelled: boolean;
  /** A seat on the waitlist or under review is not a guest yet (spec/v3.md §32.3). */
  onHold?: boolean;
}): boolean {
  if (input.cancelled || input.onHold) return false;
  switch (input.mode) {
    case 'OPEN_TO_ALL':
      return true;
    case 'ON_ADMISSION':
      return input.admitted;
    default:
      return false;
  }
}
