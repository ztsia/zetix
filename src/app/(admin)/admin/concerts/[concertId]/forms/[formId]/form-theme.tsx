'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ImageUp, Trash2 } from 'lucide-react';
import { useCanEdit } from '@/components/auth/role';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { contrastRatio, readableAccent, themeColour, type FormTheme } from '@/lib/forms/theme';
import { removeFormBannerAction, saveFormColourAction } from './theme-actions';

/**
 * The form's theme (spec/v3.md §25.6): a banner across the top, the colour
 * taken from it, and the admin's own colour over it. What the form will
 * actually use is shown as a button, contrast already checked — a banner's
 * colour that white text cannot read on is darkened, and the panel says so.
 */
export function FormThemePanel({
  concertId,
  formId,
  theme,
  bannerSrc,
}: {
  concertId: number;
  formId: number;
  theme: FormTheme | null;
  /** Where the browser loads the current banner, resolved on the server. */
  bannerSrc: string | null;
}) {
  const router = useRouter();
  const canEdit = useCanEdit();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [colour, setColour] = React.useState(theme?.colourOverride ?? theme?.colour ?? '#1a73e8');
  const inputId = React.useId();
  const colourId = React.useId();

  const used = themeColour(theme);
  const readable = used ? readableAccent(used) : null;

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set('concertId', String(concertId));
    body.set('formId', String(formId));
    body.set('file', file);
    const taken = await averageColour(file).catch(() => null);
    if (taken) body.set('colour', taken);
    try {
      const response = await fetch('/api/form-banners', { method: 'POST', body });
      const json = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setError(json.error ?? 'The banner could not be uploaded.');
      else router.refresh();
    } catch {
      setError('The banner could not be uploaded.');
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) setError(result.error ?? 'Not saved.');
    else router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Theme</CardTitle>
        <CardDescription>
          A banner across the top of the form, and its colour on the buttons and accents. Nothing else
          about the form changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {bannerSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- a stored upload, sized by CSS
          <img src={bannerSrc} alt="The form's banner" className="aspect-[4/1] w-full rounded-lg border object-cover" />
        ) : (
          <p className="text-muted-foreground text-sm">No banner.</p>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Field className="w-auto">
              <FieldLabel htmlFor={inputId} className="sr-only">
                Banner image
              </FieldLabel>
              <Input
                id={inputId}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                className="max-w-72"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = '';
                }}
              />
            </Field>
            {theme?.bannerPath && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => removeFormBannerAction(concertId, formId))}>
                <Trash2 data-icon="inline-start" />
                Remove banner
              </Button>
            )}
            {busy && <Spinner />}
            {!theme?.bannerPath && <ImageUp className="text-muted-foreground size-4" aria-hidden />}
          </div>
        )}

        <Field>
          <FieldLabel htmlFor={colourId}>Colour</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={colourId}
              type="color"
              value={colour}
              disabled={!canEdit || busy}
              className="h-9 w-14 p-1"
              onChange={(event) => setColour(event.target.value)}
            />
            {canEdit && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => saveFormColourAction(concertId, formId, colour))}>
                  Use this colour
                </Button>
                {theme?.colourOverride && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => saveFormColourAction(concertId, formId, null))}>
                    {theme.colour ? 'Use the banner’s colour' : 'Back to the default'}
                  </Button>
                )}
              </>
            )}
          </div>
          <FieldDescription>
            {theme?.colourOverride
              ? `Your colour, ${theme.colourOverride}, is used${theme.colour ? ` instead of the banner’s ${theme.colour}` : ''}.`
              : theme?.colour
                ? `Taken from the banner: ${theme.colour}.`
                : 'The form uses the site’s own colours.'}
          </FieldDescription>
        </Field>

        {readable && used && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span
              className="rounded-md px-3 py-1.5 font-medium"
              style={{ background: readable.accent, color: readable.foreground }}
            >
              Submit
            </span>
            <span className="text-muted-foreground">
              {readable.adjusted
                ? `Darkened to ${readable.accent} so button text reads (${contrastRatio(readable.accent, readable.foreground).toFixed(1)}:1).`
                : `Button text reads at ${contrastRatio(readable.accent, readable.foreground).toFixed(1)}:1.`}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The banner's colour, taken in the browser: the image drawn onto a small
 * canvas and its opaque pixels averaged, weighted towards saturated ones so a
 * white margin does not wash the colour out.
 */
async function averageColour(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const w = 0.1 + (max - min) / 255;
    r += data[i] * w;
    g += data[i + 1] * w;
    b += data[i + 2] * w;
    weight += w;
  }
  if (weight === 0) return null;
  return `#${[r, g, b].map((c) => Math.round(c / weight).toString(16).padStart(2, '0')).join('')}`;
}
