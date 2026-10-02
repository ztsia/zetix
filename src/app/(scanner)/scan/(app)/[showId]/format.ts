/**
 * A time at the door, **in the concert's zone and never the phone's**
 * (`CLAUDE.md`, spec/domain.md §6.1).
 *
 * It is read to decide whether a duplicate is somebody's second attempt tonight
 * or a scan from an earlier show. An usher whose phone is set to another
 * timezone — or is simply roaming — would otherwise be handed a number that is
 * wrong by hours and looks entirely plausible.
 *
 * A null zone falls back to the device's, because the alternative is either a
 * hardcoded zone (an operational value in code) or refusing to show a time the
 * operator needs.
 */
export function formatDoorTime(iso: string, timeZone: string | null): string {
  try {
    // 24-hour, like every other time this system prints (`lib/portal/format.ts`).
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    // An unknown zone makes Intl throw a RangeError. A wrong-looking time is
    // still better than a screen that fails to render at a door.
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
