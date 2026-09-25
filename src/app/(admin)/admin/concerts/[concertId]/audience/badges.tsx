import { Badge } from '@/components/ui/badge';
import { FLAG_LABEL, STAGE_LABEL, type Flag, type Stage } from '@/lib/audience/filter';

/**
 * How a stage and a flag look, everywhere the Audience workspace shows them.
 *
 * A stage answers "what is next", so it is neutral unless the next step is the
 * admin's; a flag answers "what is wrong", so every flag is drawn as a problem
 * (spec/v3.md §21.1, §21.2).
 */

const STAGE_VARIANT: Record<Stage, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  NEEDS_REVIEW: 'default',
  UNVERIFIED: 'outline',
  NEEDS_TICKETS: 'default',
  READY_TO_SEND: 'default',
  SENT: 'secondary',
  ADMITTED: 'secondary',
  WAITLISTED: 'outline',
  CANCELLED: 'outline',
};

export function StageBadge({ stage }: { stage: Stage | null }) {
  if (!stage) return <Badge variant="outline">No seats</Badge>;
  return <Badge variant={STAGE_VARIANT[stage]}>{STAGE_LABEL[stage]}</Badge>;
}

export function FlagBadges({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag} variant="destructive">
          {FLAG_LABEL[flag]}
        </Badge>
      ))}
    </span>
  );
}

export const SEAT_STATUS_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  PENDING_REVIEW: 'Waiting for review',
  WAITLIST: 'Waitlisted',
  CANCELLED: 'Cancelled',
};

export const ALLOCATION_LABEL: Record<string, string> = {
  BASE: 'Base',
  EXTRA: 'Extra',
  HELD: 'Held',
  COMP: 'Comp',
};

export const SOURCE_LABEL: Record<string, string> = {
  FORM: 'Form',
  IMPORT: 'Import',
  ADMIN: 'Admin',
};

export function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });
}
