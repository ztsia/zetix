'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { TOKENS, markdownToPlainText, renderTemplate } from '@/lib/email/render';
import { editTemplateAction } from '../actions';

export type PreviewRecipient = { label: string; context: Record<string, string> };

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

              <div className="rounded-md border p-4">
                <p className="text-muted-foreground text-xs">Subject</p>
                <p className="font-medium">{renderedSubject.text}</p>
                <hr className="my-3" />
                <pre className="text-sm whitespace-pre-wrap">{markdownToPlainText(renderedBody.text)}</pre>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
