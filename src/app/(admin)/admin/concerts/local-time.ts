/**
 * Instants as the venue's clock, for `datetime-local` inputs
 * (spec/domain.md §6.1).
 *
 * `datetime-local` carries no zone. Whatever string it is handed is read as
 * wall-clock, so the value must already be in the concert's zone — formatting in
 * the viewer's zone would show a Kuala Lumpur concert at a London admin's local
 * time and, worse, save it back shifted by eight hours.
 *
 * The reverse direction lives in the Server Actions, where the concert's zone is
 * read from the database rather than trusted from the browser.
 */
export function toLocalInput(
  value: Date | null | undefined,
  timeZone: string | null,
): string {
  if (!value || !timeZone) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  // en-CA gives ISO-ordered parts; hour comes back as "24" at midnight, which
  // `datetime-local` rejects.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/** A show time as a person reads it, in the concert's zone. */
export function formatShowTime(
  value: Date | null | undefined,
  timeZone: string | null,
): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}
