'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { BookOpenIcon, EyeIcon, EyeOffIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { formatBytes, MAX_ASSET_BYTES, tooLargeMessage } from '@/lib/tickets/asset-limits';
import type { BookletRow } from './queries';
import { deleteBookletAction, setBookletPublishedAction } from './actions';

/**
 * Booklet upload and publishing (spec/v2.md §13.3 item 2).
 *
 * **Upload posts to a Route Handler, publish calls a Server Action.** The split
 * is not inconsistency: a Server Action caps its request body below what a
 * programme PDF reaches, so the file goes to `/api/portal/booklet`, while the
 * flag — which carries no file — takes the ordinary path.
 *
 * **The size limit is checked here as well as at the route.** Vercel rejects an
 * oversized body before any of our code runs and answers `text/plain`, which is
 * not the JSON this is parsing — so without a check on this side the admin gets
 * "The upload failed" with no number in it (`lib/tickets/asset-limits.ts`).
 */
export function BookletManager({
  concertId,
  booklets,
  shows,
}: {
  concertId: number;
  booklets: BookletRow[];
  shows: { id: number; name: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();

  async function upload(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Choose a PDF to upload.');
      return;
    }
    if (file.size > MAX_ASSET_BYTES) {
      setError(tooLargeMessage(file.size));
      return;
    }

    setError(null);
    setUploading(true);
    try {
      data.set('concertId', String(concertId));
      const response = await fetch('/api/portal/booklet', { method: 'POST', body: data });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'The upload failed.');
        return;
      }
      form.reset();
      router.refresh();
    } catch {
      setError('The upload failed.');
    } finally {
      setUploading(false);
    }
  }

  function run(action: () => Promise<{ error: string | null }>) {
    startTransition(async () => {
      const result = await action();
      setError(result.error);
      if (!result.error) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void upload(event.currentTarget);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} name="title" required placeholder="Programme" />
            <FieldDescription>What the section is called on the portal.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-show`}>Applies to</FieldLabel>
            <NativeSelect id={`${id}-show`} name="showId" defaultValue="">
              <option value="">Every show in this concert</option>
              {shows.map((show) => (
                <option key={show.id} value={show.id}>
                  {show.name}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              A booklet for one show wins over a concert-wide one, so both can exist.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-file`}>PDF</FieldLabel>
            <Input id={`${id}-file`} name="file" type="file" accept="application/pdf" required />
            <FieldDescription>
              Up to {formatBytes(MAX_ASSET_BYTES)}. Uploaded hidden — publish it when you are ready
              for the audience to see it.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Button type="submit" disabled={uploading}>
              {uploading ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              Upload
            </Button>
          </Field>
        </FieldGroup>
      </form>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {booklets.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No booklet yet</EmptyTitle>
            <EmptyDescription>
              The portal simply leaves the section out until one is published.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {booklets.map((booklet) => (
            <Item key={booklet.id} variant="outline">
              <ItemContent>
                <ItemTitle className="text-base">{booklet.title}</ItemTitle>
                <ItemDescription>
                  {booklet.showName ?? 'Every show'}
                  {booklet.published ? null : ' · not yet visible to the audience'}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {booklet.published ? (
                  <Badge variant="secondary">Published</Badge>
                ) : (
                  <Badge variant="outline">Hidden</Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      setBookletPublishedAction(concertId, booklet.id, !booklet.published),
                    )
                  }
                >
                  {booklet.published ? (
                    <EyeOffIcon data-icon="inline-start" />
                  ) : (
                    <EyeIcon data-icon="inline-start" />
                  )}
                  {booklet.published ? 'Hide' : 'Publish'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${booklet.title}`}
                  disabled={pending}
                  onClick={() => run(() => deleteBookletAction(concertId, booklet.id))}
                >
                  <Trash2Icon />
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
