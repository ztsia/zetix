'use client';

import { useMemo, useState, useTransition } from 'react';
import { CircleAlertIcon, LightbulbIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { FormRenderer } from '@/components/forms/form-renderer';
import { emptyAnswers, type AnswerErrors, type FormAnswers } from '@/lib/forms/answers';
import type { CopyValues } from '@/lib/forms/copy';
import type { FormSchema } from '@/lib/forms/schema';
import { suggestDomainTypo } from '@/lib/email/address-typo';
import { seatIndicatorLabel, type SeatIndicator } from '@/lib/forms/seat-indicator';
import { submitRegistration, type SubmitResult } from './actions';

/**
 * Everything around `K`'s renderer: the seat indicator, the address nudge, the
 * error summary and the submit button.
 *
 * `FormRenderer` is controlled and presentational by contract — it has no
 * `<form>`, no action and no idea what a seat is — so this component holds the
 * answers and owns every one of those decisions (`K`'s handoff).
 */

export type RegistrationFormProps = {
  slug: string;
  schema: FormSchema;
  schemaVersion: number;
  limits: Readonly<Record<string, number>>;
  copy: CopyValues;
  indicator: SeatIndicator | null;
  token: string | null;
  /** A resolved player, for prefill. Null on a public form. */
  registrant: { fullName: string; email: string | null } | null;
  unknownToken: boolean;
};

/** The REGISTRANT block's system field keys (`lib/forms/system-fields.ts`). */
const CONTACT_NAME = 'contact_name';
const CONTACT_EMAIL = 'contact_email';

export function RegistrationForm({
  slug,
  schema,
  schemaVersion,
  limits,
  copy,
  indicator,
  token,
  registrant,
  unknownToken,
}: RegistrationFormProps) {
  const registrantBlockId = useMemo(
    () => schema.blocks.find((block) => block.type === 'REGISTRANT')?.id ?? null,
    [schema],
  );

  /**
   * Prefilled from the player token where there is one (§8.1.1).
   *
   * Computed once as the initial state rather than written in an effect: an
   * effect would overwrite whatever the person had already typed if anything
   * upstream re-rendered, and the prefill is a starting point, not a lock — a
   * player whose roster email is out of date must be able to correct it here.
   */
  const [answers, setAnswers] = useState<FormAnswers>(() => {
    const initial = emptyAnswers(schema, limits);
    if (!registrant || registrantBlockId === null) return initial;
    const block = initial[registrantBlockId];
    if (block?.kind !== 'flat') return initial;
    return {
      ...initial,
      [registrantBlockId]: {
        kind: 'flat',
        values: {
          ...block.values,
          ...(CONTACT_NAME in block.values ? { [CONTACT_NAME]: registrant.fullName } : {}),
          ...(registrant.email && CONTACT_EMAIL in block.values
            ? { [CONTACT_EMAIL]: registrant.email }
            : {}),
        },
      },
    };
  });

  const [errors, setErrors] = useState<AnswerErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Set once the reader has been shown an address warning and submitted anyway.
   *
   * The address checks refuse a domain DNS is certain does not exist, which is
   * right for `gmail.con` and wrong for the day a resolver misbehaves. Rather
   * than choose between blocking a real registrant forever and letting a
   * certainly-undeliverable address through, the first attempt is refused with
   * the reason and the second is accepted. Nobody is locked out of a scarce
   * seat by a DNS answer, and nobody types `.con` without being told.
   */
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();

  const contactEmail = useMemo(() => {
    if (registrantBlockId === null) return '';
    const block = answers[registrantBlockId];
    if (block?.kind !== 'flat') return '';
    const value = block.values[CONTACT_EMAIL];
    return typeof value === 'string' ? value : '';
  }, [answers, registrantBlockId]);

  /**
   * The typo nudge, live as they type.
   *
   * Pure and synchronous, so the same function runs here and on the server at
   * submit — one implementation, one set of answers. DNS cannot see this class
   * of mistake at all: `gmial.com` is registered and has MX records.
   */
  const suggestion = useMemo(() => suggestDomainTypo(contactEmail), [contactEmail]);

  const applySuggestion = () => {
    if (registrantBlockId === null || !suggestion) return;
    const block = answers[registrantBlockId];
    if (block?.kind !== 'flat') return;
    const at = contactEmail.lastIndexOf('@');
    if (at <= 0) return;
    setAnswers({
      ...answers,
      [registrantBlockId]: {
        kind: 'flat',
        values: {
          ...block.values,
          [CONTACT_EMAIL]: `${contactEmail.slice(0, at + 1)}${suggestion}`,
        },
      },
    });
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    startTransition(async () => {
      const result: SubmitResult = await submitRegistration({
        slug,
        token,
        schemaVersion,
        answers,
        addressConfirmed,
      });

      if (result.ok) {
        // A full page navigation, not a client push: the confirmation is a
        // different page with its own data, and the back button landing on a
        // submitted form would invite a second party.
        window.location.assign(result.confirmationUrl);
        return;
      }

      setErrors(result.errors ?? {});
      setFormError(result.message ?? null);
      if (result.addressWarning) setAddressConfirmed(true);
      // The summary is above the form, and a long form has scrolled past it.
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-8">
      {indicator && indicator.state !== 'FULL' ? (
        <div>
          <Badge variant={indicator.state === 'BAND' ? 'secondary' : 'outline'}>
            {seatIndicatorLabel(indicator)}
          </Badge>
        </div>
      ) : null}

      {unknownToken ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>We did not recognise that link</AlertTitle>
          <AlertDescription>
            Your details have not been filled in. You can still register below, or check the link in
            your invitation.
          </AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Your registration was not submitted</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {suggestion ? (
        <Alert>
          <LightbulbIcon />
          <AlertTitle>Did you mean {suggestion}?</AlertTitle>
          <AlertDescription>
            Your tickets are sent to this address, so it is worth a second look.
          </AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="sm" onClick={applySuggestion}>
              Use {suggestion}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <FormRenderer
        schema={schema}
        limits={limits}
        copy={copy}
        value={answers}
        onValueChange={setAnswers}
        errors={errors}
        disabled={pending}
      />

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {pending ? 'Submitting…' : 'Submit registration'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Seats are confirmed when you submit. We will email your tickets before the concert.
        </p>
      </div>
    </form>
  );
}
