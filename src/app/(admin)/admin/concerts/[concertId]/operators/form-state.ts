/**
 * What module `H`'s operator actions return to their forms.
 *
 * In its own module because a `'use server'` file may export **only async
 * functions**, so a shared type beside the actions fails the build with a
 * message pointing at the wrong line — the same reason `concerts/form-state.ts`
 * and `auth/login-state.ts` exist.
 */
export type IssuedCode = {
  displayName: string;
  /**
   * Shown **once** and never recoverable (spec/admin.md §14.3).
   *
   * It lives in the action's return value and nowhere else: not in the database
   * in readable form, not in `audit_log`, not in a log line. If the admin closes
   * the dialog without copying it, the only way forward is to issue another one.
   */
  accessCode: string;
};

export type OperatorFormState = {
  error: string | null;
  message?: string | null;
  /** Present only on the two actions that mint a code. */
  issued?: IssuedCode | null;
};

export const NO_OPERATOR_FORM_STATE: OperatorFormState = {
  error: null,
  message: null,
  issued: null,
};
