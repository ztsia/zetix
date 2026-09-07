'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, RotateCcw } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { clearSystemSettingAction, setSystemSettingAction } from './actions';
import type { SettingSpec } from './catalogue';

/**
 * One tunable, at the root of the cascade.
 *
 * Each row saves on its own. A single "save all" form over thirty keys would
 * make one bad value reject twenty-nine good ones — and the entitlement guard
 * genuinely does reject a whole edit, so that would be a real loss rather than a
 * theoretical one.
 *
 * A blank field **clears** the key rather than writing an empty value. For an
 * operational value "nobody has set this" is a real state (spec/domain.md §6),
 * and it has to be reachable from the screen that set it.
 */
export function SettingRow({
  spec,
  value,
}: {
  spec: SettingSpec;
  /** The raw jsonb at the system level, or undefined when the key has no row. */
  value: unknown;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => toInput(spec, value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isSet = value !== undefined && value !== null;
  const original = toInput(spec, value);
  const dirty = draft !== original;

  function run(action: () => Promise<{ error: string | null }>) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function save() {
    const formData = new FormData();
    formData.append('key', spec.key);
    formData.append('value', draft);
    run(() => setSystemSettingAction({ error: null }, formData));
  }

  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium">
            {spec.label}
          </label>
          <p className="text-muted-foreground mt-0.5 text-sm">{spec.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <code className="text-muted-foreground text-xs">{spec.key}</code>
            {spec.level !== 'system' && (
              <Badge variant="outline" className="font-normal">
                usually set per {spec.level}
              </Badge>
            )}
            {/* An operational value with no row anywhere is not "off" — it is a
                save-time error waiting to happen at allocation or at a blast. */}
            {spec.operational && !isSet && (
              <Badge variant="outline" className="text-muted-foreground font-normal">
                not set anywhere
              </Badge>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {spec.kind === 'boolean' ? (
            <NativeSelect
              id={id}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-32"
            >
              <option value="">Not set</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </NativeSelect>
          ) : (
            <Input
              id={id}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              inputMode={spec.kind === 'number' ? 'numeric' : undefined}
              placeholder={spec.operational ? 'not set' : ''}
              className={spec.kind === 'json' ? 'w-96 font-mono text-xs' : 'w-40'}
            />
          )}

          <Button size="sm" onClick={save} disabled={isPending || !dirty}>
            {isPending ? <Spinner /> : saved && !dirty ? <Check /> : null}
            Save
          </Button>

          {isSet && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Clear ${spec.label}`}
              disabled={isPending}
              onClick={() => {
                setDraft('');
                run(() => clearSystemSettingAction(spec.key));
              }}
            >
              <RotateCcw />
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          {/* Changing a capacity or quota key here re-checks every show, and the
              refusal names the segment and the shortfall (spec/allocation.md
              §7.4). It is the admin's next instruction, so it is shown whole. */}
          <AlertTitle className="text-sm leading-relaxed font-normal whitespace-pre-wrap">
            {error}
          </AlertTitle>
        </Alert>
      )}
    </div>
  );
}

/** The stored jsonb, as the string its input holds. */
function toInput(spec: SettingSpec, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (spec.kind === 'json') return JSON.stringify(value);
  if (spec.kind === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
