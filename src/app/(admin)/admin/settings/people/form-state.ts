/**
 * What Settings › People's actions return to their forms.
 *
 * In its own module because a `'use server'` file may export only async
 * functions (the same reason `operators/form-state.ts` exists).
 */
export type IssuedPassword = {
  displayName: string;
  email: string;
  /**
   * Shown **once** and never recoverable. It lives in the action's return value
   * and nowhere else: not in the database in readable form, not in `audit_log`,
   * not in a log line.
   */
  password: string;
};

export type PeopleFormState = {
  error: string | null;
  message?: string | null;
  issued?: IssuedPassword | null;
};
