'use client';

import { useState, useTransition } from 'react';
import { CircleCheckIcon, MessageSquareHeartIcon } from 'lucide-react';
import { FormRenderer } from '@/components/forms/form-renderer';
import { RichText } from '@/components/forms/rich-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { emptyAnswers, type AnswerErrors, type FormAnswers } from '@/lib/forms/answers';
import type { CopyValues } from '@/lib/forms/copy';
import type { FormSchema } from '@/lib/forms/schema';

/**
 * §13.5 — the post-show feedback form, answered in the portal.
 *
 * **`K`'s renderer draws it; this owns where it is answered.** The form is built
 * in `L`'s builder and exported by `L`'s exporter — three modules on one form,
 * which is exactly why there is one renderer (spec/surfaces.md §15.2).
 *
 * **The thank-you is a state of this section, not a redirect.** A guest who has
 * answered opens the same link again — from the same email — and must see that
 * their answer landed, with a way back to it. Sending them to a separate page
 * would break the one URL they have.
 */
export function FeedbackSection({
  token,
  formId,
  schema,
  title,
  descriptionMd,
  copy,
  existing,
  submit,
}: {
  token: string;
  formId: number;
  schema: FormSchema;
  title: string;
  descriptionMd: string | null;
  copy: CopyValues;
  existing: FormAnswers | null;
  submit: (token: string, payload: unknown) => Promise<{ ok: boolean; errors: AnswerErrors }>;
}) {
  /**
   * An existing answer opens as a thank-you rather than a filled-in form: the
   * common reason to re-open the link is to check it was received, not to
   * rewrite it. "Change my answer" is one tap away for the other case.
   */
  const [answered, setAnswered] = useState(existing !== null);
  const [value, setValue] = useState<FormAnswers>(
    /**
     * Merged over an empty shape rather than used directly. A stored answer was
     * written against the schema pinned at the time, and an admin who has since
     * added a question would otherwise leave the renderer with no entry for that
     * block at all.
     */
    () => ({ ...emptyAnswers(schema, {}), ...(existing ?? {}) }),
  );
  const [errors, setErrors] = useState<AnswerErrors>({});
  const [pending, startTransition] = useTransition();

  function onSubmit() {
    startTransition(async () => {
      const result = await submit(token, value);
      setErrors(result.errors);
      if (result.ok) setAnswered(true);
    });
  }

  if (answered) {
    return (
      <Card key={formId}>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
            <CircleCheckIcon className="size-4 text-muted-foreground" />
            Thank you
          </CardTitle>
          <CardDescription>
            Your feedback has reached the orchestra.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" size="lg" className="h-12" onClick={() => setAnswered(false)}>
            Change my answer
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card key={formId}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
          <MessageSquareHeartIcon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {/*
          * `RichText` outside `CardDescription` rather than inside it: the
          * description slot is a single line of muted text and this is block
          * content — paragraphs and lists — which would be nested in it
          * invalidly.
          */}
        {descriptionMd ? (
          <RichText markdown={descriptionMd} className="text-sm text-muted-foreground" />
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/*
         * `limits` is empty because a FEEDBACK schema has no repeaters — the zod
         * contract refuses every seat block on this kind (§13.5). It is passed
         * explicitly rather than defaulted so that a repeater appearing here
         * renders as unconfigured, which is the renderer's own refusal, rather
         * than as unlimited.
         */}
        <FormRenderer
          schema={schema}
          limits={{}}
          copy={copy}
          value={value}
          onValueChange={setValue}
          errors={errors}
          disabled={pending}
        />

        {errors._form ? (
          <Alert variant="destructive">
            <AlertTitle>That did not send</AlertTitle>
            <AlertDescription>{errors._form}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button size="lg" className="h-12 w-full text-base" onClick={onSubmit} disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Send feedback
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The form was open and is now shut — `portal.feedback_close_at` has passed.
 *
 * **Rendered rather than omitted.** The guest followed a link from an email we
 * sent them; "we have stopped collecting answers" is an answer, and an empty
 * page where the form was is not.
 */
export function FeedbackClosed() {
  return (
    <Alert>
      <MessageSquareHeartIcon />
      <AlertTitle>Feedback has closed</AlertTitle>
      <AlertDescription>
        Thank you to everyone who wrote in — the orchestra has read them all.
      </AlertDescription>
    </Alert>
  );
}
