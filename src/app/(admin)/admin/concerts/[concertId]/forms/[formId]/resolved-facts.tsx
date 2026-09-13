import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { OriginBadge } from '../../../cascade-hint';
import { formatInZone } from '@/lib/export';
import type { ResolvedSetting } from '@/db/cascade-origin';
import { PARTY_CAP_KEY } from '../party-cap';

/**
 * What this form inherits, and from where (spec/README.md §2.2, decision 43).
 *
 * **Read-only, and that is the design.** Every figure here is a *segment* value
 * (`domain.md` §6) resolved through the four-level cascade. A form is not a
 * level of that cascade, so an input on this screen would either write a column
 * nothing reads or add a fifth level below the one the spec calls
 * authoritative. Both are worse than a link to the screen that does own them.
 *
 * It earns its tab anyway: these are the numbers a form's copy interpolates and
 * its repeaters count rows against, so "why does this form offer three guests?"
 * is answered here rather than by opening the segment and inferring.
 */

const LABEL: Record<string, string> = {
  [PARTY_CAP_KEY]: 'Party size',
  'form.extra_rows_max': 'Extra-seat rows',
  'allocation.base_quota': 'Base seats per player',
  'allocation.base_claim_deadline': 'Base claim deadline',
};

const MEANING: Record<string, string> = {
  [PARTY_CAP_KEY]:
    'Total seats in one public party, the registrant included — so the guest repeater offers one fewer row.',
  'form.extra_rows_max': 'Rows in the “request extra seats” section.',
  'allocation.base_quota':
    'Seats each active player is entitled to. The base section offers what a player has left, not the whole quota.',
  'allocation.base_claim_deadline':
    'After this, unclaimed base seats release into the extras pool.',
};

export function ResolvedFacts({
  concertId,
  segmentId,
  cascade,
  timeZone,
}: {
  concertId: number;
  segmentId: number | null;
  cascade: Record<string, ResolvedSetting>;
  timeZone: string | null;
}) {
  if (segmentId === null) {
    return (
      <Alert>
        <AlertTitle>A feedback form inherits none of this</AlertTitle>
        <AlertDescription>
          It belongs to a show rather than a segment, creates no seats, and has no
          repeating sections — so there is no capacity, quota or party cap for it to read.
        </AlertDescription>
      </Alert>
    );
  }

  const entries = Object.entries(LABEL);

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        These belong to the segment, not to this form — so two rounds on one segment read
        the same figures, and changing one here would be changing it for both. They are
        set on the{' '}
        <Link
          href={`/admin/concerts/${concertId}/shows`}
          className="underline underline-offset-4"
        >
          Shows
        </Link>{' '}
        screen.
      </p>

      {entries.map(([key, label]) => {
        const resolved = cascade[key];
        const value = resolved?.value;
        const unset = value === null || value === undefined;

        return (
          <Item key={key} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{label}</ItemTitle>
              <ItemDescription>{MEANING[key]}</ItemDescription>
            </ItemContent>
            <ItemActions className="gap-2">
              <OriginBadge resolved={resolved} />
              <span className={unset ? 'text-destructive text-sm' : 'text-sm font-medium tabular-nums'}>
                {unset ? 'not set' : formatValue(key, value, timeZone)}
              </span>
            </ItemActions>
          </Item>
        );
      })}
    </div>
  );
}

/**
 * A deadline renders in the concert's zone, never the reader's (`CLAUDE.md`).
 *
 * The same rule the ticket follows, for the same reason: a committee member
 * reading this on a laptop set to another zone must see the deadline the
 * players were told.
 */
function formatValue(key: string, value: unknown, timeZone: string | null): string {
  if (key !== 'allocation.base_claim_deadline') return String(value);
  if (!timeZone) return String(value);
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : formatInZone(date, timeZone);
}
