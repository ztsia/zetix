/**
 * The typed phrase §11.4 requires before a resend.
 *
 * In its own module because a `'use server'` file may export **only async
 * functions** — a plain constant beside the actions compiles and then fails at
 * runtime pointing at the wrong line. Module `B` hit this and put its own
 * phrase in `src/lib/registrations/confirmation.ts` for the same reason.
 *
 * Shared with the screen so the button's label and the action's check cannot
 * disagree about what counts as deliberate.
 */
export const RESEND_PHRASE = 'RESEND TICKETS';
