/**
 * The words an admin types to commit past a ceiling
 * (spec/allocation.md §7.5, §7.6).
 *
 * **Both screens ask for the same phrase.** §7.6 requires a typed confirmation
 * to exceed the hall on the manual path, exactly as §7.5 does on the review
 * commit — so a checkbox on one screen and a typed phrase on the other would not
 * merely be inconsistent, it would leave the weaker of the two as the place a
 * stray click overfills the hall.
 *
 * A plain module, not a `'use server'` one: such a file may export only async
 * functions, and a `const` beside the actions compiles and then fails at
 * runtime pointing at the wrong line (the same reason `form-state.ts` exists).
 */
export const OVERSELL_PHRASE = 'OVER CAPACITY';

/** Whether what the admin typed authorises going past a ceiling. */
export function confirmsOverCapacity(typed: string): boolean {
  return typed.trim().toUpperCase() === OVERSELL_PHRASE;
}
