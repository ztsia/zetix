'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  QrCode,
  Save,
  Square,
  Type,
  Upload,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import type { TicketData } from '@/lib/tickets/bindings';
import {
  canvasSizeFor,
  createElement,
  nudgeElement,
  removeElement,
  reorderElement,
  resizeCanvas,
  updateElement,
  type AssetMeasurement,
} from '@/lib/tickets/editor-elements';
import type { Layout, LayoutElement } from '@/lib/tickets/layout';
import type { PreviewOption, PreviewSubject } from '@/lib/tickets/preview';
import type { TemplateDetail } from '@/lib/tickets/templates';
import { ElementProperties } from './element-properties';
import { saveTemplateAction } from '../actions';

/**
 * The canvas editor (spec/tickets.md §10.3).
 *
 * **`ssr: false` is not optional.** Konva touches `window` at import time, so a
 * server render throws before the page reaches the browser. §10.3 names the
 * requirement; this is where it is honoured.
 */
const EditorCanvas = dynamic(() => import('./editor-canvas'), {
  ssr: false,
  loading: () => <Skeleton className="h-[420px] w-full" />,
});

export type TemplateEditorProps = {
  concertId: number;
  template: TemplateDetail;
  shows: { id: number; name: string }[];
  showId: number | null;
  previewOptions: PreviewOption[];
  previewData: TicketData;
  /** Carried across the navigation a clone forces — see `save()`. */
  savedMessage?: string | null;
};

type Feedback = { ok: boolean; text: string } | null;

export function TemplateEditor({
  concertId,
  template,
  shows,
  showId,
  previewOptions,
  previewData,
  savedMessage,
}: TemplateEditorProps) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [layout, setLayout] = useState<Layout>(template.layout);
  const [backgroundPath, setBackgroundPath] = useState<string | null>(
    template.backgroundAssetPath,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [subject, setSubject] = useState<PreviewSubject>(
    previewOptions[0]?.subject ?? 'SAMPLE',
  );
  const [feedback, setFeedback] = useState<Feedback>(
    savedMessage ? { ok: true, text: savedMessage } : null,
  );
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  /**
   * Whether the draft differs from what is stored.
   *
   * Compared by value rather than tracked by a flag, so a change and its exact
   * reversal correctly reads as "nothing to save" — and so the warning below
   * cannot be left stuck on by a code path that forgets to clear a flag.
   */
  const dirty =
    name !== template.name ||
    backgroundPath !== template.backgroundAssetPath ||
    JSON.stringify(layout) !== JSON.stringify(template.layout);

  useUnsavedChangesWarning(dirty);

  const selected = useMemo(
    () => layout.elements.find((element) => element.id === selectedId) ?? null,
    [layout.elements, selectedId],
  );

  const assetUrl = useCallback((src: string) => `/api/ticket-assets/${src}`, []);
  const backgroundUrl = useRasterisedBackground(backgroundPath, assetUrl);

  /** Arrow keys nudge, 1pt and 10pt with shift (§10.3). */
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never while a field has focus: the same keys move a caret there, and
      // stealing them makes every number input feel broken.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const step = event.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        setLayout((current) => nudgeElement(current, selectedId, move[0], move[1]));
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        setLayout((current) => removeElement(current, selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  const addElement = (spec: Parameters<typeof createElement>[1]) => {
    const element = createElement(layout, spec);
    setLayout({ ...layout, elements: [...layout.elements, element] });
    setSelectedId(element.id);
  };

  const patchSelected = (patch: Partial<LayoutElement>) => {
    if (!selectedId) return;
    setLayout((current) => updateElement(current, selectedId, patch));
  };

  async function upload(file: File): Promise<{ path: string; kind: string } | null> {
    const body = new FormData();
    body.set('concertId', String(concertId));
    body.set('file', file);
    const response = await fetch('/api/ticket-assets', { method: 'POST', body });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setFeedback({ ok: false, text: payload?.error ?? 'The upload failed.' });
      return null;
    }
    return payload;
  }

  async function onBackgroundChosen(file: File) {
    setBusy(true);
    setFeedback(null);
    try {
      const uploaded = await upload(file);
      if (!uploaded) return;
      setBackgroundPath(uploaded.path);

      /**
       * §10.3: "Canvas dimensions derive from the asset; for PDF the page box in
       * points is authoritative." Measured from the file itself rather than
       * assumed, because a layout whose canvas disagrees with its background
       * puts every element somewhere other than where it was placed — the
       * renderer reads coordinates against the *real* page box.
       */
      const measured = await measureAsset(file);
      // Computed outside the updater: a state updater must be pure, and React
      // is free to run it twice.
      const page = measured ? canvasSizeFor(measured, layout.canvas.dpi) : null;
      if (page) setLayout((current) => resizeCanvas(current, page.width_pt, page.height_pt));

      setFeedback({
        ok: true,
        text:
          measured && page
            ? `Artwork loaded. Page set to ${page.width_pt} × ${page.height_pt} pt` +
              (measured.unit === 'px'
                ? `, from ${measured.width} × ${measured.height} px at ${layout.canvas.dpi} dpi — correct the dpi below if the artwork was exported at another.`
                : ', from the PDF page box.')
            : 'Artwork loaded.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function onImageChosen(file: File) {
    setBusy(true);
    setFeedback(null);
    try {
      const uploaded = await upload(file);
      if (!uploaded) return;
      if (uploaded.kind !== 'IMAGE') {
        setFeedback({
          ok: false,
          text: 'A PDF can be the background, but only a PNG or JPEG can be placed as an image.',
        });
        return;
      }
      addElement({ type: 'IMAGE', src: uploaded.path });
    } finally {
      setBusy(false);
    }
  }

  function save() {
    startTransition(async () => {
      const result = await saveTemplateAction({
        concertId,
        templateId: template.id,
        name,
        layout,
        backgroundAssetPath: backgroundPath,
      });
      if (result.ok && result.templateId && result.templateId !== template.id) {
        /**
         * A clone is a different row, so the editor has to follow it — staying
         * put would leave the admin editing the frozen version they just left.
         *
         * **The message travels with the navigation** rather than being set
         * here. Setting it here put it on screen for about 300 ms before the
         * route change threw the component away, so the one sentence explaining
         * that a *new version* was made — the §10.5 behaviour an admin most
         * needs to understand — was the sentence nobody could read.
         */
        router.push(
          `/admin/concerts/${concertId}/tickets/templates/${result.templateId}` +
            `?saved=${encodeURIComponent(result.message)}`,
        );
        return;
      }
      setFeedback({ ok: result.ok, text: result.ok ? result.message : result.error });
      if (result.ok) router.refresh();
    });
  }

  /**
   * The authoritative overflow check (§10.3's longest-name preview).
   *
   * The canvas approximates; this asks the renderer that actually makes the PDF
   * and reports what it had to clip. Opened in a new tab rather than embedded so
   * an admin sees it at the browser's own PDF zoom, which is how they will check
   * a QR's size.
   */
  async function previewPdf() {
    if (!showId) {
      setFeedback({ ok: false, text: 'Add a show to this concert before previewing.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const option = previewOptions.find((candidate) => candidate.subject === subject);
      const response = await fetch('/api/tickets/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          concertId,
          showId,
          subject,
          attendeeId: option?.attendeeId ?? null,
          layout,
          backgroundAssetPath: backgroundPath,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setFeedback({ ok: false, text: payload?.error ?? 'The preview could not be rendered.' });
        return;
      }

      const truncated: string[] = JSON.parse(response.headers.get('x-ticket-truncated') ?? '[]');
      const skipped: string[] = JSON.parse(response.headers.get('x-ticket-skipped') ?? '[]');
      const blob = await response.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');

      setFeedback({
        ok: truncated.length === 0 && skipped.length === 0,
        text:
          truncated.length === 0 && skipped.length === 0
            ? `Rendered ${option?.fullName ?? 'the preview'} with nothing clipped.`
            : [
                truncated.length > 0
                  ? `Clipped: ${truncated.join(', ')} — the text did not fit its box.`
                  : null,
                skipped.length > 0 ? `Not drawn: ${skipped.join(', ')}.` : null,
              ]
                .filter(Boolean)
                .join(' '),
      });
    } finally {
      setBusy(false);
    }
  }

  const working = busy || pending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field className="max-w-xs">
          <FieldLabel htmlFor="template-name">Template</FieldLabel>
          <Input
            id="template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">v{template.version}</Badge>
          {template.issuedCount > 0 && (
            <Badge variant="secondary">
              {template.issuedCount} issued — saving makes v{template.version + 1}
            </Badge>
          )}
          <Button variant="outline" onClick={previewPdf} disabled={working}>
            <FileText />
            Preview PDF
          </Button>
          <Button onClick={save} disabled={working || !dirty}>
            <Save />
            Save
          </Button>
        </div>
      </div>

      {feedback && (
        <Alert variant={feedback.ok ? 'default' : 'destructive'}>
          {feedback.ok ? (
            <CheckCircle2 className="size-4" aria-hidden />
          ) : (
            <AlertTriangle className="size-4" aria-hidden />
          )}
          <AlertDescription>{feedback.text}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ButtonGroup>
              <Button
                variant="outline"
                size="sm"
                onClick={() => addElement({ type: 'TEXT', binding: 'attendee.full_name' })}
              >
                <Type />
                Variable
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => addElement({ type: 'TEXT', binding: null })}
              >
                <Type />
                Text
              </Button>
              <Button variant="outline" size="sm" onClick={() => addElement({ type: 'QR' })}>
                <QrCode />
                QR
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => imageRef.current?.click()}
              >
                <ImageIcon />
                Image
              </Button>
              <Button variant="outline" size="sm" onClick={() => addElement({ type: 'RECT' })}>
                <Square />
                Shape
              </Button>
            </ButtonGroup>

            <div className="flex items-center gap-2">
              <Switch id="boxes" checked={showBoxes} onCheckedChange={setShowBoxes} />
              <Label htmlFor="boxes" className="text-muted-foreground text-sm">
                Show boxes
              </Label>
            </div>
          </div>

          <EditorCanvas
            layout={layout}
            data={previewData}
            backgroundUrl={backgroundUrl}
            assetUrl={assetUrl}
            selectedId={selectedId}
            showBoxes={showBoxes}
            onSelect={setSelectedId}
            onChange={(id, patch) => setLayout((current) => updateElement(current, id, patch))}
          />

          <p className="text-muted-foreground text-xs">
            {layout.canvas.width_pt} × {layout.canvas.height_pt} pt. Drag to move, drag a handle
            to resize, arrow keys to nudge (hold shift for 10 pt). On-screen text is measured
            with the browser&apos;s fonts — use Preview PDF to see what the renderer really
            prints.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Preview data</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {shows.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="show">Show</FieldLabel>
                  <Select
                    value={String(showId ?? '')}
                    onValueChange={(value) => {
                      if (!value) return;
                      // The preview rows come from the server, so changing the
                      // show is a navigation rather than local state.
                      router.push(
                        `/admin/concerts/${concertId}/tickets/templates/${template.id}?show=${value}`,
                      );
                    }}
                  >
                    <SelectTrigger id="show">
                      <SelectValue>
                        {(value: string) =>
                          shows.find((show) => String(show.id) === value)?.name ?? value
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {shows.map((show) => (
                        <SelectItem key={show.id} value={String(show.id)}>
                          {show.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="subject">Preview against</FieldLabel>
                <Select
                  value={subject}
                  onValueChange={(value) => value && setSubject(value as PreviewSubject)}
                >
                  <SelectTrigger id="subject">
                    <SelectValue>
                      {(value: string) =>
                        previewOptions.find((option) => option.subject === value)?.label ?? value
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {previewOptions.map((option) => (
                      <SelectItem key={option.subject} value={option.subject}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  The longest name in the show is the one that overflows. Check it before a
                  blast, not after.
                </FieldDescription>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Background</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">
                {backgroundPath
                  ? `${template.backgroundKind === 'PDF' || backgroundPath.endsWith('.pdf') ? 'PDF' : 'Image'} artwork loaded.`
                  : 'No artwork. The ticket prints as type on a blank page.'}
              </p>
              <ButtonGroup>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload />
                  {backgroundPath ? 'Replace' : 'Upload'}
                </Button>
                {backgroundPath && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={working}
                    onClick={() => setBackgroundPath(null)}
                  >
                    Remove
                  </Button>
                )}
              </ButtonGroup>
              <FieldDescription>PNG, JPEG or a PDF whose page 1 is the ticket.</FieldDescription>

              {/*
                The page size is derived from the artwork, and for an image that
                derivation depends on a dpi nothing in the file reliably states.
                These three fields are the escape hatch: without them a wrong
                guess leaves an admin with a 43 × 62 cm ticket and no way back.
              */}
              <div className="grid grid-cols-3 gap-2">
                <Field>
                  <FieldLabel htmlFor="page-w">Width pt</FieldLabel>
                  <Input
                    id="page-w"
                    type="number"
                    min={1}
                    value={layout.canvas.width_pt}
                    onChange={(event) => {
                      const width = Number(event.target.value);
                      if (width > 0) {
                        setLayout((current) =>
                          resizeCanvas(current, width, current.canvas.height_pt),
                        );
                      }
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="page-h">Height pt</FieldLabel>
                  <Input
                    id="page-h"
                    type="number"
                    min={1}
                    value={layout.canvas.height_pt}
                    onChange={(event) => {
                      const height = Number(event.target.value);
                      if (height > 0) {
                        setLayout((current) =>
                          resizeCanvas(current, current.canvas.width_pt, height),
                        );
                      }
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="page-dpi">Dpi</FieldLabel>
                  <Input
                    id="page-dpi"
                    type="number"
                    min={1}
                    value={layout.canvas.dpi}
                    onChange={(event) => {
                      const dpi = Number(event.target.value);
                      if (dpi > 0) {
                        setLayout((current) => ({
                          ...current,
                          canvas: { ...current.canvas, dpi },
                        }));
                      }
                    }}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Element</CardTitle>
            </CardHeader>
            <CardContent>
              <ElementProperties
                element={selected}
                onChange={patchSelected}
                onRemove={() => {
                  if (!selectedId) return;
                  setLayout((current) => removeElement(current, selectedId));
                  setSelectedId(null);
                }}
                onReorder={(direction) => {
                  if (!selectedId) return;
                  setLayout((current) => reorderElement(current, selectedId, direction));
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void onBackgroundChosen(file);
        }}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void onImageChosen(file);
        }}
      />
    </div>
  );
}

/**
 * The browser's own "leave site?" prompt while a draft is unsaved.
 *
 * There is no autosave and no undo, so a closed tab is a lost afternoon. This is
 * the one line of protection the platform gives for free.
 */
function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/**
 * A background the canvas can draw: the image itself, or page 1 of a PDF
 * rasterised in the browser.
 *
 * Konva draws images, not PDFs. The rasterisation is **for the screen only** —
 * the renderer still draws onto the original vector PDF (§10.4), so print
 * quality is untouched by whatever resolution is used here.
 *
 * If `pdfjs` cannot load, the canvas falls back to a blank page rather than
 * failing: laying elements out over an outline is worse than over the artwork,
 * but it still works, and Preview PDF still shows the truth.
 */
function useRasterisedBackground(
  path: string | null,
  assetUrl: (src: string) => string,
): string | null {
  const isPdf = Boolean(path?.endsWith('.pdf'));
  const [rasterised, setRasterised] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    // An image needs no rasterising, so there is nothing to do here for one —
    // it is returned straight below.
    if (!path || !isPdf) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();

        const response = await fetch(assetUrl(path));
        if (!response.ok) return;
        const document = await pdfjs.getDocument({
          data: new Uint8Array(await response.arrayBuffer()),
        }).promise;
        const page = await document.getPage(1);

        // 2× the page box: sharp enough to judge artwork against at any
        // sensible zoom, without making a canvas the browser has to hold in
        // memory at print resolution.
        const viewport = page.getViewport({ scale: 2 });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) return;

        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setRasterised({ key: path, url: objectUrl });
      } catch {
        // Leave it unrasterised: the canvas falls back to a blank page below.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, isPdf, assetUrl]);

  if (!path) return null;
  if (!isPdf) return assetUrl(path);
  // Keyed, so replacing one PDF with another never leaves the old artwork on
  // screen while the new one rasterises.
  return rasterised?.key === path ? rasterised.url : null;
}

/**
 * The artwork's own dimensions, **in its own unit**.
 *
 * Converting to points is `canvasSizeFor()`'s job, because it needs the
 * template's dpi and this does not. A PDF's page box is already points and
 * authoritative (§10.3); an image is pixels.
 */
async function measureAsset(file: File): Promise<AssetMeasurement | null> {
  if (file.type === 'application/pdf') {
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      const document = await pdfjs.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
      }).promise;
      const viewport = (await document.getPage(1)).getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height, unit: 'pt' };
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const image = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight, unit: 'px' });
      URL.revokeObjectURL(objectUrl);
    };
    image.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(objectUrl);
    };
    image.src = objectUrl;
  });
}
