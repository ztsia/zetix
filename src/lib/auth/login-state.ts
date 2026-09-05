/**
 * The shape a login Server Action returns to its form.
 *
 * In its own module because a `'use server'` file may export **only async
 * functions** — a plain constant beside the actions fails the build with a
 * message that points at the wrong line.
 */
export type LoginState = { error: string | null };

export const NO_STATE: LoginState = { error: null };
