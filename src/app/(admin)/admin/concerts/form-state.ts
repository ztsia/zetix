/**
 * The shape module `A`'s Server Actions return to their forms.
 *
 * In its own module because a `'use server'` file may export **only async
 * functions** — a plain constant beside the actions fails the build with a
 * message that points at the wrong line (the same reason `auth/login-state.ts`
 * exists).
 *
 * `error` carries the database's own sentence where there is one. The guards in
 * `drizzle/0001_allocation_engine.sql` raise messages written for an admin to
 * act on — "82 active players × 2 base = 164 seats, but the segment holds 100.
 * Reduce the quota to 1, raise capacity to 164, or deactivate 32 players." —
 * so this is rendered verbatim and never replaced with a generic failure
 * (spec/allocation.md §7.4).
 */
export type FormState = {
  error: string | null;
  /** Set on success so a form can confirm what happened without a toast. */
  message?: string | null;
  /**
   * The contact email changed after tickets were delivered to the old one: the
   * record asks whether to resend them (spec/v3.md §22.4).
   */
  resendOffer?: boolean;
};

export const NO_FORM_STATE: FormState = { error: null, message: null };

/**
 * A URL-safe slug derived from a concert's name.
 *
 * Shared between the client (which previews it as you type) and the action
 * (which re-derives it, because the client's value is untrusted). Two callers,
 * one function: a slug that differs between preview and save is a link that
 * does not work.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip diacritics so "Sinfonía" and "Sinfonia" produce the same slug.
    // Written as escapes: the combining marks are invisible in a source file,
    // and an editor that normalises the line would silently empty the class.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
