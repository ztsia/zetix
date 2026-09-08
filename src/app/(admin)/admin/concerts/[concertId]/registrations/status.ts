/**
 * How a booking status reads at a glance.
 *
 * In its own module because both the table and the sheet render it, and a
 * status that is amber in one place and grey in the other is a status nobody
 * trusts. `PENDING_REVIEW` is deliberately not `destructive`: a request held for
 * the §7.5 batch grant is the normal path for a player segment, not a problem.
 */
export const STATUS_TONE: Record<
  'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED',
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  CONFIRMED: 'default',
  PENDING_REVIEW: 'secondary',
  WAITLIST: 'outline',
  CANCELLED: 'destructive',
};

export const STATUS_LABEL: Record<keyof typeof STATUS_TONE, string> = {
  CONFIRMED: 'Confirmed',
  PENDING_REVIEW: 'In review',
  WAITLIST: 'Waiting',
  CANCELLED: 'Cancelled',
};
