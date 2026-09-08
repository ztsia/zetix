/**
 * The words an admin types to commit past a ceiling (spec/allocation.md §7.5).
 *
 * In its own module because a `'use server'` file may export **only async
 * functions** — the same reason `form-state.ts` and `auth/login-state.ts` exist.
 * Exporting it from `actions.ts` compiles under `tsc` and fails at runtime with
 * a message pointing at the wrong thing.
 *
 * Shared so the dialog asks for exactly what the action checks: a confirmation
 * phrase that differs between the two is a button that can never be pressed.
 */
export const OVERSELL_PHRASE = 'OVER CAPACITY';
