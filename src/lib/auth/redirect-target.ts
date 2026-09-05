/**
 * Validates the `?next=` parameter a login form carries.
 *
 * The proxy sets this so a deep link survives sign-in. It arrives from the URL,
 * so it is attacker-controlled: without this check `/login?next=https://evil.example`
 * turns our own login form into an open redirect, which is the classic way to
 * make a phishing link look like it came from us.
 *
 * Only a same-site absolute path is accepted. `//host` is rejected explicitly —
 * it is protocol-relative and browsers read it as another origin even though it
 * starts with a slash.
 */
export function safeRedirect(next: string | null | undefined, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  if (next.includes('\\')) return fallback;
  return next;
}
