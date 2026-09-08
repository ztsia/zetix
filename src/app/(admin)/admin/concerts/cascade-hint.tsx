import type { CascadeLevel, ResolvedSetting } from '@/db/cascade-origin';
import { Badge } from '@/components/ui/badge';
import { FieldDescription } from '@/components/ui/field';

/**
 * What a cascading field says underneath itself (spec/README.md §2.2).
 *
 * A capacity input showing "300" is ambiguous in a way that matters: the 300
 * may be this segment's own, or the concert's, and clearing the field means
 * something different in each case. The form binds to the raw column — blank is
 * "no override here" — and this line says what happens if it is left blank.
 *
 * The distinction is the whole reason the four-level cascade needs a UI rather
 * than six number inputs.
 */

const LEVEL_LABEL: Record<CascadeLevel, string> = {
  segment: 'this segment',
  show: 'this show',
  concert: 'the concert',
  system: 'system defaults',
  unset: 'nowhere',
};

/**
 * Operational values carry no seed anywhere (spec/domain.md §6), so "nothing has
 * set this" is a real state a config screen must be able to render — and it is
 * the state that stops a blast or an allocation later, so it is called out
 * rather than shown as an empty cell.
 */
export function CascadeHint({
  resolved,
  level,
  format,
}: {
  resolved: ResolvedSetting | undefined;
  /** The level this form edits. */
  level: 'segment' | 'show';
  format?: (value: unknown) => string;
}) {
  if (!resolved) return null;

  if (resolved.origin === 'unset') {
    return (
      <FieldDescription>
        Not set at any level — enter a value here, or higher up, before this
        matters.
      </FieldDescription>
    );
  }

  if (resolved.origin === level) {
    return <FieldDescription>Set here.</FieldDescription>;
  }

  const shown = format ? format(resolved.value) : String(resolved.value);
  return (
    <FieldDescription>
      Leave blank to inherit <strong>{shown}</strong> from {LEVEL_LABEL[resolved.origin]}.
    </FieldDescription>
  );
}

/**
 * The same fact as a badge, for read-only rows where a sentence is too much.
 *
 * Rendered only for inherited values: labelling every value with its origin
 * makes the overridden ones — the interesting ones — harder to pick out, not
 * easier.
 */
export function OriginBadge({ resolved }: { resolved: ResolvedSetting | undefined }) {
  if (!resolved || resolved.origin === 'segment' || resolved.origin === 'show') return null;
  if (resolved.origin === 'unset') {
    return (
      <Badge variant="outline" className="text-muted-foreground font-normal">
        not set
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground font-normal">
      from {LEVEL_LABEL[resolved.origin]}
    </Badge>
  );
}
