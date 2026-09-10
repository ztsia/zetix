import { TicketNotFound } from './ticket-not-found';

/**
 * The route group's not-found boundary, for anything under `(portal)` that
 * does not match a route.
 *
 * `/t/{token}` does **not** reach here: an unresolvable token is rendered by
 * the page itself rather than thrown, for the reason set out in
 * `t/[token]/page.tsx`. This exists so that everything else in the group still
 * lands on the same friendly page rather than the framework's bare 404.
 */
export default function PortalNotFound() {
  return <TicketNotFound />;
}
