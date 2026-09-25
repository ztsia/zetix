'use client';

import { useActionState, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { NO_FORM_STATE } from '../../form-state';
import { savePracticalInfoAction } from './actions';
import { AdminOnly } from '@/components/auth/role';

/**
 * §13.3 item 5 — the concert's practical info: parking, latecomers, the interval.
 *
 * Markdown, rendered on the portal through `RichText` rather than as HTML, which
 * is why the supported subset is stated here rather than left to be discovered:
 * an admin who writes a table and sees a paragraph should have been told first.
 */
export function PracticalInfoForm({
  concertId,
  value,
}: {
  concertId: number;
  value: string | null;
}) {
  const id = useId();
  const [state, formAction, pending] = useActionState(
    savePracticalInfoAction.bind(null, concertId),
    NO_FORM_STATE,
  );

  return (
    <form action={formAction}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-md`}>Practical info</FieldLabel>
          <Textarea
            id={`${id}-md`}
            name="practicalInfoMd"
            rows={10}
            defaultValue={value ?? ''}
            placeholder={'Parking is available under the hall.\n\nLatecomers are seated at the interval.'}
          />
          <FieldDescription>
            Shown to ticket holders who have unlocked the portal. Paragraphs, lists,
            <strong> bold</strong>, <em>italic</em> and links — other Markdown is printed as
            written.
          </FieldDescription>
        </Field>

        <Field orientation="horizontal">
          <AdminOnly>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </AdminOnly>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
        </Field>
      </FieldGroup>
    </form>
  );
}
