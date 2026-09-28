'use client';

import { useMemo, useState, useTransition } from 'react';
import { CircleAlertIcon, ClockIcon, LightbulbIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { FormRenderer, hasRequiredQuestion } from '@/components/forms/form-renderer';
import { FormCard, FormHeaderCard } from '@/components/forms/form-surface';
import { PLAYER_PICKER, type PickerPlayer } from '@/lib/forms/player-picker';
import { RichText } from '@/components/forms/rich-text';
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
  title: string;
  /** The form's introduction, as markdown. */
  description: string | null;
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
  /**
   * The player form's roster, when no `?k=` token named the player
   * (spec/v3.md §25.2). Null on a public form, or when the token resolved.
   */
  roster?: PickerPlayer[] | null;
  /** The segment is full and the form is in waitlist mode (spec/v3.md §25.6). */
  waitlist?: boolean;
};

/** The REGISTRANT block's system field keys (`lib/forms/system-fields.ts`). */
const CONTACT_NAME = 'contact_name';
const CONTACT_EMAIL = 'contact_email';

export function RegistrationForm({
  title,
  description,
  slug,
  schema,
  schemaVersion,
  limits,
  copy,
  indicator,
  token,
  registrant,
  unknownToken,
  roster = null,
  waitlist = false,
}: RegistrationFormProps) {
  const [picked, setPicked] = useState<PickerPlayer | null>(null);
  const baseBlockId = useMemo(
    () => schema.blocks.find((block) => block.type === 'GUESTS_BASE')?.id ?? null,
    [schema],
  );
  /**
   * The base repeater is sized for the picked player: the seats they have left,
   * not the segment's quota (§8.1.1's "remaining", now per picked player). The
   * server recomputes it at submit; this is what the reader sees meanwhile.
   */
  const liveLimits = useMemo(
    () =>
      picked && baseBlockId !== null ? { ...limits, [baseBlockId]: picked.remaining ?? 0 } : limits,
    [limits, picked, baseBlockId],
  );
  const pickerId = useMemo(() => `picker-${slug}`, [slug]);
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
  const [initialAnswers] = useState<FormAnswers>(() => {
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
  const [answers, setAnswers] = useState<FormAnswers>(initialAnswers);

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
        playerId: picked?.id ?? null,
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

  /**
   * "Clear form", as on Google Forms: back to how the page opened — the player's
   * prefilled name and email included, because those came from the link and
   * are not answers the reader typed — with every error and warning dropped.
   */
  const [confirmClear, setConfirmClear] = useState(false);
  const clearForm = () => {
    setConfirmClear(false);
    setAnswers(initialAnswers);
    setErrors({});
    setFormError(null);
    setAddressConfirmed(false);
    setPicked(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <FormHeaderCard
        title={title}
        description={description ? <RichText markdown={description} /> : null}
        requiredNote={hasRequiredQuestion(schema)}
      >
        {indicator && indicator.state !== 'FULL' ? (
          <div>
            <Badge variant={indicator.state === 'BAND' ? 'secondary' : 'outline'}>
              {seatIndicatorLabel(indicator)}
            </Badge>
          </div>
        ) : null}

        {waitlist ? (
          <Alert>
            <ClockIcon />
            <AlertTitle>This show is full — you can join the waitlist</AlertTitle>
            <AlertDescription>
              Register below and your party joins the waitlist. As seats free up they are offered first
              come first served, and we will email you if one is yours.
            </AlertDescription>
          </Alert>
        ) : null}

        {unknownToken ? (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>We did not recognise that link</AlertTitle>
            <AlertDescription>
              Your details have not been filled in. You can still register below, or check the
              link in your invitation.
            </AlertDescription>
          </Alert>
        ) : null}
      </FormHeaderCard>

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

      {roster ? (
        <FormCard invalid={Boolean(errors[PLAYER_PICKER])}>
          <Field data-invalid={Boolean(errors[PLAYER_PICKER]) || undefined}>
            <FieldLabel htmlFor={pickerId}>
              Which player invited you?<span className="text-form-error"> *</span>
            </FieldLabel>
            <Combobox
              items={roster}
              itemToStringValue={(player: PickerPlayer) => player.name}
              value={picked}
              onValueChange={(next: PickerPlayer | null) => {
                setPicked(next);
                // A new player means a new base allocation: drop blank base
                // rows past what this player has left, keep anything typed.
                if (next && baseBlockId !== null) {
                  const block = answers[baseBlockId];
                  if (block?.kind === 'repeater') {
                    const cap = next.remaining ?? 0;
                    const rows = block.rows.filter(
                      (row, index) =>
                        index < cap ||
                        Object.values(row).some((value) => typeof value === 'string' && value.trim() !== ''),
                    );
                    setAnswers({ ...answers, [baseBlockId]: { kind: 'repeater', rows } });
                  }
                }
              }}
              disabled={pending}
            >
              <ComboboxInput id={pickerId} placeholder="Search by name" showClear />
              <ComboboxContent>
                <ComboboxEmpty>No player by that name.</ComboboxEmpty>
                <ComboboxList>
                  {(player: PickerPlayer) => (
                    <ComboboxItem key={player.id} value={player}>
                      {player.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {picked ? (
              <FieldDescription>
                {(picked.remaining ?? 0) > 0
                  ? `${picked.name} has ${picked.remaining} invited seat${picked.remaining === 1 ? '' : 's'} left.`
                  : `${picked.name} has no invited seats left.` +
                    (schema.blocks.some((block) => block.type === 'GUESTS_EXTRA')
                      ? ' You can still ask for extra seats below.'
                      : '')}
              </FieldDescription>
            ) : (
              <FieldDescription>Your seats are part of that player’s allocation.</FieldDescription>
            )}
            {errors[PLAYER_PICKER] ? <FieldError>{errors[PLAYER_PICKER]}</FieldError> : null}
          </Field>
        </FormCard>
      ) : null}

      <FormRenderer
        schema={schema}
        limits={liveLimits}
        copy={copy}
        value={answers}
        onValueChange={setAnswers}
        errors={errors}
        disabled={pending}
      />

      <div className="mt-1 flex items-center justify-between gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? 'Submitting…' : waitlist ? 'Join the waitlist' : 'Submit'}
        </Button>

        {/*
          Behind a confirm, as on Google Forms: one stray tap on a phone would
          otherwise wipe a party of four's names with no way back. Controlled,
          because `AlertDialogAction` is a plain button and does not close its
          own dialog.
        */}
        <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
          <AlertDialogTrigger render={<Button type="button" variant="ghost" disabled={pending} />}>
            Clear form
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear form?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove your answers from all questions and cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={clearForm}>Clear form</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <p className="text-muted-foreground pb-6 text-xs">
        {waitlist
          ? 'You will be told by email if a seat becomes yours.'
          : 'Seats are confirmed when you submit. We will email your tickets before the concert.'}
      </p>
    </form>
  );
}
