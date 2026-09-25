/**
 * The digest a viewer's refused Server Action carries to the browser
 * (spec/v3.md §28).
 *
 * In a production build Next replaces a Server Action's error message with a
 * generic one, so the message cannot tell the console what went wrong — but an
 * error that already has a `digest` keeps it. `ReadOnlyAccountError` sets this
 * one, and the admin error boundary reads it to say "your account is read-only"
 * instead of "something went wrong".
 *
 * In its own module, with no `server-only`, because the error boundary is a
 * Client Component and imports it.
 */
export const READ_ONLY_DIGEST = 'READ_ONLY_ACCOUNT';

export const READ_ONLY_MESSAGE = 'Your account is read-only. Ask an admin to make this change.';
