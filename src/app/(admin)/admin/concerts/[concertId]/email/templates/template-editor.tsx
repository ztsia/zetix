'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { TOKENS, markdownToEmailHtml, markdownToPlainText, renderTemplate } from '@/lib/email/render';
import { editTemplateAction } from '../actions';

export type PreviewRecipient = { label: string; context: Record<string, string> };

/**
 * Tokens whose value is computed from *this* recipient's own rows rather than
 * entered on a record — so a blank one is a fact about the recipient, not a
 * gap an admin can go and fill.
 *
 * Stated here rather than inferred from the name, because the difference
 * changes the advice the warning gives and getting it wrong once cost a
 * template its links.
 */
const PER_RECIPIENT_TOKENS = new Set([
  'ticket_links',
  'feedback_links',
  'attendee_names',
  'attendee_count',
  'admitted_count',
]);


/**
 * The template editor of §11.3 and §11.5 — Markdown, a documented token list,
 * and a **live preview against a real recipient, never a lorem stub**
 * (`ref.md` §6).
 *
 * The picker carries the two cases the spec names, because template bugs are
 * almost always data-shape bugs: the **longest name** in the segment, and a
 * party with **no player linked**. A preview against a tidy example proves
 * nothing about the row that breaks the layout.
 */
export function TemplateEditor({
  templateKey,
  name,
  subject: initialSubject,
  bodyMd: initialBody,
  recipients,
}: {
  templateKey: string;
  name: string;
  subject: string;
  bodyMd: string;
  recipients: PreviewRecipient[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ error: string | null; message?: string | null } | null>(null);

  const [subject, setSubject] = useState(initialSubject);
  const [bodyMd, setBodyMd] = useState(initialBody);
  const [who, setWho] = useState(0);

  const context = recipients[who]?.context ?? {};
  const renderedSubject = renderTemplate(subject, context);
  const renderedBody = renderTemplate(bodyMd, context);
  const unknown = [...new Set([...renderedSubject.unknown, ...renderedBody.unknown])];
  const empty = [...new Set([...renderedSubject.empty, ...renderedBody.empty])];

  function save() {
    const formData = new FormData();
    formData.set('templateKey', templateKey);
    formData.set('subject', subject);
    formData.set('bodyMd', bodyMd);
    startTransition(async () => {
      setFeedback(await editTemplateAction(formData));
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field>
            <FieldLabel htmlFor="subject">Subject</FieldLabel>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>

          <Field>
            <FieldLabel htmlFor="bodyMd">Body (Markdown)</FieldLabel>
            <Textarea
              id="bodyMd"
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
              rows={18}
              className="font-mono text-sm"
            />
            <FieldDescription>
              Saving re-renders every draft nobody has hand-edited. Messages edited individually are
              left alone, and anything already queued or sent is never touched.
            </FieldDescription>
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium">Available tokens</p>
            <div className="flex flex-wrap gap-1">
              {TOKENS.map((token) => (
                <Badge
                  key={token.token}
                  variant="outline"
                  title={token.description}
                  className="cursor-pointer font-mono text-xs"
                  onClick={() => setBodyMd((current) => `${current}{{ ${token.token} }}`)}
                >
                  {token.token}
                </Badge>
              ))}
            </div>
          </div>

          <Button onClick={save} disabled={pending}>
            {pending ? <Spinner /> : null}
            Save template
          </Button>

          {feedback?.error ? (
            <Alert variant="destructive">
              <AlertTitle className="whitespace-pre-wrap">{feedback.error}</AlertTitle>
            </Alert>
          ) : null}
          {feedback?.message ? (
            <Alert>
              <AlertTitle className="whitespace-pre-wrap">{feedback.message}</AlertTitle>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {recipients.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No registration to preview against yet. A preview against invented data would not tell
              you what a real one looks like.
            </p>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="recipient">Preview against</FieldLabel>
                <Select value={String(who)} onValueChange={(value) => setWho(Number(value))}>
                  <SelectTrigger id="recipient">
                    <SelectValue>{recipients[who]?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {recipients.map((recipient, index) => (
                      <SelectItem key={recipient.label} value={String(index)}>
                        {recipient.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {/*
                Unknown tokens render as an empty string, and an empty string in
                the middle of a sentence is what reaches four hundred inboxes
                unnoticed. Surfaced while the wording can still be fixed.
              */}
              {unknown.length > 0 ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    Unknown token(s): {unknown.join(', ')} — these render as blank.
                  </AlertTitle>
                </Alert>
              ) : null}

              {/*
                A *known* token with no value behind it reads the same way in an
                inbox: `**When:**` followed by nothing. The template is fine and
                the data is missing, so this is a warning rather than an error —
                `registration.round_label` is legitimately blank for plenty of
                rows — but it must be on screen before the blast, not after.
              */}
              {/*
                **Two kinds of blank, and only one of them is yours to fix.**

                A show or concert detail — the times, the venue — is blank
                because nobody has entered it, and entering it is the fix. A
                per-recipient list is blank because *this* party has no seats,
                or none that were admitted; the next recipient may be fine, and
                the data is not something you type in.

                The old wording offered one instruction for both — "fill it in
                on the show or concert, or drop it from the wording" — which on
                a feedback message reads as "delete {{ feedback_links }}". That
                sends a feedback email with no way to give feedback. So the
                advice now separates the two and refuses the deletion outright.
              */}
              {empty.length > 0 ? (
                <Alert>
                  <AlertTitle>Blank for this recipient: {empty.join(', ')}</AlertTitle>
                  <AlertDescription>
                    {empty.some((token) => PER_RECIPIENT_TOKENS.has(token)) ? (
                      <>
                        A list like <code>ticket_links</code> or <code>feedback_links</code> is
                        built per recipient — blank means this party has no ticketed seats, or
                        none that were admitted. Check another recipient above before changing
                        anything. <strong>Do not remove a link token to silence this</strong>: the
                        message is the link.
                      </>
                    ) : (
                      <>
                        The token resolves, but there is no value behind it — fill it in on the
                        show or concert, or drop it from the wording.
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="rounded-md border">
                <div className="p-4">
                  <p className="text-muted-foreground text-xs">Subject</p>
                  <p className="font-medium">{renderedSubject.text}</p>
                </div>

                {/*
                  Both halves of the message, because they are rendered
                  differently and only one of them used to be on screen.

                  The plain-text half breaks on every newline; the HTML half
                  follows Markdown, where a single newline is a *soft* break.
                  A preview that showed only the text half therefore rendered
                  `{{ ticket_links }}` as one link per line while recipients
                  received all of them run together — the exact class of bug
                  §11.5's preview exists to catch, invisible to the preview
                  itself.
                */}
                <Tabs defaultValue="formatted" className="gap-0 border-t">
                  <TabsList className="m-4 mb-0">
                    <TabsTrigger value="formatted">Formatted</TabsTrigger>
                    <TabsTrigger value="plain">Plain text</TabsTrigger>
                  </TabsList>

                  <TabsContent value="formatted" className="p-4">
                    {/*
                      Framed rather than injected: the message carries its own
                      document and inline styles, and `srcDoc` in a sandboxed
                      frame is what keeps those from meeting the admin
                      stylesheet in either direction. `sandbox=""` withholds
                      every permission, scripts included.
                    */}
                    <iframe
                      key={renderedBody.text}
                      title="Formatted preview"
                      sandbox=""
                      srcDoc={markdownToEmailHtml(renderedBody.text)}
                      className="h-[28rem] w-full rounded-md border bg-white"
                    />
                  </TabsContent>

                  <TabsContent value="plain" className="p-4">
                    <pre className="text-sm whitespace-pre-wrap">
                      {markdownToPlainText(renderedBody.text)}
                    </pre>
                  </TabsContent>
                </Tabs>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
