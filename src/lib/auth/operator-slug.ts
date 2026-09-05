/**
 * The operator's synthetic address (spec/checkin.md §12.1, decision 20a).
 *
 * Supabase's password provider is keyed on an email, so an operator gets one
 * shaped like an email that can never resolve: `.invalid` is reserved by
 * RFC 2606 for exactly this. Nothing is ever sent to it and the operator never
 * sees or types it — they enter a display name and an access code.
 *
 * **This module is shared with operator provisioning** (module `H`,
 * `/admin/operators`). The address the admin creates and the address the login
 * form derives must agree character for character, and the failure mode when
 * they do not is an usher who simply cannot sign in, with nothing in the logs to
 * say why. One implementation, imported by both — never a second one.
 */
export const OPERATOR_EMAIL_DOMAIN = 'operators.invalid';

/**
 * A display name reduced to a stable slug.
 *
 * Unicode is decomposed and combining marks dropped, so "Siti Nur Aisyah" and
 * "Sïti Nur Aisyah" reach the same account — an usher typing their own name
 * without diacritics on a phone keyboard is the common case, not an edge one.
 */
export function operatorSlug(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function operatorEmail(displayName: string): string {
  const slug = operatorSlug(displayName);
  return `${slug}@${OPERATOR_EMAIL_DOMAIN}`;
}
