'use client';

import { useId, useState, useTransition } from 'react';
import { CircleCheckIcon, PencilLineIcon, UsersIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { ExistingNote, NoteRecipient } from '@/lib/portal/notes';

/**
 * §13.4 — the note an attendee leaves after the concert.
 *
 * **Purpose-built rather than driven by `K`'s renderer**, for the reason `M`
 * gave for its edit screen: this is not a form schema an admin authored, it is
 * four fixed controls whose behaviour is specified field by field in §13.4.
 * Running it through the renderer would mean expressing "prefilled but
 * changeable, from the attendee's segment" as form JSON, which no schema in
 * this system can say.
 *
 * **The recipient control is a `Combobox`, not a `Select`.** This concert has
 * around eighty players (`context.md`) and a `PUBLIC` attendee is looking for
 * one name among them on a phone. A `Select` is for a fixed short list; past
 * roughly six options a list without search is a scroll.
 */

/**
 * "The whole orchestra" as an option in the same list as the players.
 *
 * It is a sentinel rather than a separate control because the column it writes
 * is one nullable `to_player_id`: modelling it as a checkbox beside the picker
 * would let a guest tick "everyone" *and* name a player, which is a state the
 * schema cannot store and the UI would then have to arbitrate.
 */
const EVERYONE = 'everyone';

type Option = { key: string; label: string; hint: string | null };

export function NotesSection({
  token,
  state,
  players,
  defaultToPlayerId,
  existing,
  maxLength,
  submit,
}: {
  token: string;
  state: 'OPEN' | 'CLOSED';
  players: NoteRecipient[];
  defaultToPlayerId: number | null;
  existing: ExistingNote | null;
  maxLength: number | null;
  submit: (
    token: string,
    payload: unknown,
  ) => Promise<{ ok: boolean; errors: Record<string, string> }>;
}) {
  const fieldId = useId();

  const options: Option[] = [
    { key: EVERYONE, label: 'The whole orchestra', hint: null },
    ...players.map((p) => ({
      key: String(p.id),
      label: p.name,
      /** Whichever the roster has; both columns are nullable on `players`. */
      hint: p.instrument ?? p.section,
    })),
  ];

  /**
   * An existing note's recipient wins over the prefill, and the prefill only
   * applies to a first note. Otherwise a player-invited guest who deliberately
   * addressed the whole orchestra would find their inviting player back in the
   * box every time they reopened the page.
   */
  const initialRecipient = existing
    ? existing.toPlayerId === null
      ? EVERYONE
      : String(existing.toPlayerId)
    : defaultToPlayerId === null
      ? EVERYONE
      : String(defaultToPlayerId);

  const [body, setBody] = useState(existing?.body ?? '');
  const [recipient, setRecipient] = useState<string>(initialRecipient);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [isAnonymous, setIsAnonymous] = useState(existing?.isAnonymous ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  /**
   * A saved note collapses to a confirmation, as `N`'s feedback section does:
   * the common reason to reopen the link is to check the note landed, not to
   * rewrite it. "Edit my note" is one tap away for the other case.
   */
  const [saved, setSaved] = useState(existing !== null);

  const closed = state === 'CLOSED';
  const over = maxLength !== null && body.trim().length > maxLength;

  function onSubmit() {
    startTransition(async () => {
      const result = await submit(token, {
        body,
        toPlayerId: recipient === EVERYONE ? null : Number(recipient),
        displayName: displayName.trim() === '' ? null : displayName,
        isAnonymous,
      });
      setErrors(result.errors);
      if (result.ok) setSaved(true);
    });
  }

  /**
   * Closed with nothing written is the one case that draws no card. There is no
   * note to reread and no form to fill, so a section saying "notes have closed"
   * to somebody who never left one is a notice about a thing they did not do.
   */
  if (closed && !existing) return null;

  if (closed && existing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PencilLineIcon className="size-4 text-muted-foreground" />
            Your note
          </CardTitle>
          <CardDescription>
            Notes have closed, so this one can no longer be changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm whitespace-pre-wrap">{existing.body}</p>
          <NoteStatus note={existing} />
        </CardContent>
      </Card>
    );
  }

  if (saved) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleCheckIcon className="size-4 text-muted-foreground" />
            Your note has been sent
          </CardTitle>
          <CardDescription>Thank you — the orchestra will read it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm whitespace-pre-wrap">{body}</p>
          {existing ? <NoteStatus note={existing} /> : null}
        </CardContent>
        <CardFooter>
          <Button variant="outline" size="lg" onClick={() => setSaved(false)}>
            Edit my note
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PencilLineIcon className="size-4 text-muted-foreground" />
          Leave a note
        </CardTitle>
        <CardDescription>
          A few words for the orchestra, or for one player in it.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <FieldGroup>
          <Field data-invalid={errors.body || over ? true : undefined}>
            <FieldLabel htmlFor={`${fieldId}-body`}>Your note</FieldLabel>
            <Textarea
              id={`${fieldId}-body`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={pending}
              rows={5}
              aria-invalid={errors.body || over ? true : undefined}
              /**
               * **Not `maxLength`.** A hard attribute silently swallows the
               * characters past the cap, so a guest pasting a long message
               * watches the end of it disappear with no explanation. The
               * counter below tells them, and the action refuses it — the
               * cap is enforced where it can be reported.
               */
              placeholder="What stayed with you?"
            />
            {maxLength !== null ? (
              <FieldDescription
                className={over ? 'text-destructive' : undefined}
                aria-live="polite"
              >
                {body.trim().length} / {maxLength} characters
              </FieldDescription>
            ) : null}
            {errors.body ? <FieldError>{errors.body}</FieldError> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${fieldId}-to`}>Who is it for?</FieldLabel>
            <Combobox
              items={options}
              itemToStringValue={(option: Option) => option.label}
              value={options.find((o) => o.key === recipient) ?? options[0]}
              onValueChange={(next: Option | null) => setRecipient(next?.key ?? EVERYONE)}
              disabled={pending}
            >
              <ComboboxInput
                id={`${fieldId}-to`}
                placeholder="Search for a player"
              />
              <ComboboxContent>
                <ComboboxEmpty>Nobody by that name is playing.</ComboboxEmpty>
                <ComboboxList>
                  {(option: Option) => (
                    <ComboboxItem key={option.key} value={option}>
                      <span className="flex items-center gap-2">
                        {option.key === EVERYONE ? (
                          <UsersIcon className="size-4 text-muted-foreground" />
                        ) : null}
                        {option.label}
                        {option.hint ? (
                          <span className="text-muted-foreground text-xs">{option.hint}</span>
                        ) : null}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <FieldDescription>
              A note for one player reaches them personally and never goes on the
              public wall.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${fieldId}-name`}>Sign it as</FieldLabel>
            <Input
              id={`${fieldId}-name`}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={pending}
              placeholder="Your name"
            />
            <FieldDescription>
              Leave this blank to use the name on your ticket.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Switch
              id={`${fieldId}-anon`}
              checked={isAnonymous}
              onCheckedChange={setIsAnonymous}
              disabled={pending}
            />
            <FieldContentLabel htmlFor={`${fieldId}-anon`} />
          </Field>

          {errors._form ? (
            <Alert variant="destructive">
              <AlertTitle>That did not send</AlertTitle>
              <AlertDescription>{errors._form}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </CardContent>

      <CardFooter>
        <Button size="lg" className="w-full" onClick={onSubmit} disabled={pending || over}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {existing ? 'Save my note' : 'Send my note'}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The anonymity toggle's label and its caveat, which is the half a guest
 * actually needs: §13.4 hides the name *on the wall* and never from admin, and
 * a control labelled only "Post anonymously" would promise more than that.
 */
function FieldContentLabel({ htmlFor }: { htmlFor: string }) {
  return (
    <div className="grid gap-0.5">
      <FieldLabel htmlFor={htmlFor}>Show my note without my name</FieldLabel>
      <FieldDescription>
        Your name stays with the orchestra either way — this only hides it from
        the public wall.
      </FieldDescription>
    </div>
  );
}

/**
 * Where the note has got to, told to the person who wrote it.
 *
 * **`HIDDEN` is not shown as a verdict.** `moderation_status` is admin triage
 * and a guest told their note was hidden has been handed a rejection notice
 * nobody wrote; it reads as still waiting, which is true of everything that is
 * not yet on the wall.
 */
function NoteStatus({ note }: { note: ExistingNote }) {
  if (note.wallStatus === 'PUBLISHED') {
    return <Badge variant="secondary">On the public wall</Badge>;
  }
  return <Badge variant="outline">With the orchestra</Badge>;
}
