'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import QRCode from 'qrcode';
import { useCanEdit } from '@/components/auth/role';
import { Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva';
import { interpolate, resolveBinding, type TicketData } from '@/lib/tickets/bindings';
import { clampSize } from '@/lib/tickets/editor-elements';
import type { Layout, LayoutElement, QrElement, TextElement } from '@/lib/tickets/layout';

/**
 * The canvas (spec/tickets.md §10.3).
 *
 * **Loaded with `ssr: false`.** Konva draws to a `<canvas>` and reaches for
 * `window` at import time, so rendering it on the server throws before the page
 * ever reaches the browser — §10.3 names the constraint for this reason.
 *
 * Coordinates are **points throughout**, exactly as stored in the layout. The
 * stage carries a single scale factor to fit the page on screen, so nothing
 * inside converts between screen pixels and points; a element's `x` is the
 * number that ends up in the jsonb and in the PDF. One conversion, in one
 * place, is the same discipline the renderer applies to its top-down flip.
 *
 * What this deliberately is not: snap guides, multi-select, undo. §10.3 lists
 * them, and they are the difference between an afternoon and a week — the
 * artwork for this concert has to be laid out before 13 Sep. Every element is
 * individually draggable and resizable, which is what the job needs.
 */

/** Fonts the browser has, standing in for the embedded ones (`fonts.ts`). */
function cssFont(family: string): string {
  return /mono/i.test(family)
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : `${family}, system-ui, -apple-system, Segoe UI, sans-serif`;
}

/**
 * The text a preview shows for an element.
 *
 * The same two functions the renderer calls, so what the canvas shows and what
 * the PDF prints come from one implementation of the binding rules — including
 * `{{placeholder}}` interpolation and the empty string a null value resolves to.
 */
function textOf(element: TextElement, data: TicketData): string {
  return element.binding
    ? resolveBinding(element.binding, data, { format: element.format })
    : interpolate(element.text ?? '', data, { format: element.format });
}

/**
 * `overflow: 'SHRINK'`, approximated for the screen.
 *
 * Konva measures with the browser's fonts and pdf-lib measures with the
 * embedded ones, so this lands close but not exact — which is why the toolbar's
 * PDF preview exists and reports what the **renderer** actually clipped. Without
 * some emulation here a long name would simply spill across the ticket on
 * screen, which is a worse lie than a slightly different one.
 */
function shrinkToFit(element: TextElement, value: string): number {
  const probe = new Konva.Text({
    text: value,
    fontSize: element.font_size,
    fontFamily: cssFont(element.font_family),
    fontStyle: element.font_weight >= 600 ? 'bold' : 'normal',
    width: element.w,
    wrap: element.max_lines > 1 ? 'word' : 'none',
    lineHeight: 1.2,
  });

  if (element.overflow !== 'SHRINK') return element.font_size;

  let size = element.font_size;
  for (let step = 0; step < 40 && size > 4; step += 1) {
    probe.fontSize(size);
    const lines = element.max_lines > 1 ? probe.textArr.length : 1;
    const width = element.max_lines > 1 ? 0 : probe.measureSize(value).width;
    if (lines <= element.max_lines && width <= element.w) break;
    size -= 0.5;
  }
  return size;
}

/**
 * A QR as one image rather than a thousand rectangles.
 *
 * The loaded image is **keyed by what it was loaded for**, and a key that no
 * longer matches reads as nothing. That is not bookkeeping: without it, changing
 * the previewed attendee leaves the previous attendee's QR on the canvas until
 * the new one finishes encoding, which is a preview showing the wrong person's
 * ticket.
 */
function useQrImage(element: QrElement, value: string): HTMLImageElement | null {
  const key = `${value}|${element.ec_level}|${element.margin_modules}`;
  const [loaded, setLoaded] = useState<{ key: string; image: HTMLImageElement } | null>(null);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;

    QRCode.toDataURL(value, {
      errorCorrectionLevel: element.ec_level,
      margin: element.margin_modules,
      // Generous and square: the stage scales it down to the element's box, so
      // a fixed source size keeps it crisp at any zoom without re-encoding.
      width: 512,
      color: { dark: '#000000ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (cancelled) return;
        const image = new window.Image();
        image.src = url;
        image.onload = () => !cancelled && setLoaded({ key, image });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [key, value, element.ec_level, element.margin_modules]);

  return loaded?.key === key ? loaded.image : null;
}

/** An `<img>` load, keyed the same way and for the same reason. */
function useUrlImage(src: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ key: string; image: HTMLImageElement } | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;

    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.src = src;
    image.onload = () => !cancelled && setLoaded({ key: src, image });

    return () => {
      cancelled = true;
    };
  }, [src]);

  return src && loaded?.key === src ? loaded.image : null;
}

export type EditorCanvasProps = {
  layout: Layout;
  data: TicketData;
  /** Already rasterised where it was a PDF — see `template-editor.tsx`. */
  backgroundUrl: string | null;
  assetUrl: (src: string) => string;
  selectedId: string | null;
  showBoxes: boolean;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<LayoutElement>) => void;
};

export default function EditorCanvas({
  layout,
  data,
  backgroundUrl,
  assetUrl,
  selectedId,
  showBoxes,
  onSelect,
  onChange,
}: EditorCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canEdit = useCanEdit();
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Group>());
  const [width, setWidth] = useState(0);

  // Fit to the container's width. A ticket is laid out against the whole page,
  // so seeing all of it matters more than seeing it at 100%.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const scale = width > 0 ? Math.min(width / layout.canvas.width_pt, 2) : 0;
  const background = useUrlImage(backgroundUrl);

  // Keep the transform handles on whatever is selected, including after an
  // element is deleted underneath them.
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedId ? nodes.current.get(selectedId) : undefined;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, layout.elements, scale]);

  const commitTransform = useCallback(
    (element: LayoutElement, node: Konva.Group) => {
      /**
       * Konva resizes by scaling the node; the layout has no scale, only a box.
       * So the scale is read off, folded into `w`/`h`, and reset to 1 — leave it
       * on and the next resize multiplies rather than replaces, and the element
       * grows exponentially under the admin's hands.
       */
      const { w, h } = clampSize(element.w * node.scaleX(), element.h * node.scaleY());
      node.scaleX(1);
      node.scaleY(1);
      onChange(element.id, {
        x: round(node.x()),
        y: round(node.y()),
        w: round(w),
        h: round(h),
        rotation: round(node.rotation()),
      });
    },
    [onChange],
  );

  const stageHeight = layout.canvas.height_pt * scale;

  return (
    <div ref={containerRef} className="w-full">
      {scale > 0 && (
        <Stage
          width={layout.canvas.width_pt * scale}
          height={stageHeight}
          scaleX={scale}
          scaleY={scale}
          // A click on the page itself, rather than on an element, clears the
          // selection — the standard gesture, and the only way to get the
          // transform handles out of the way to judge a design.
          onMouseDown={(event) => {
            if (event.target === event.target.getStage()) onSelect(null);
          }}
          onTouchStart={(event) => {
            if (event.target === event.target.getStage()) onSelect(null);
          }}
          className="bg-background rounded-md border shadow-sm"
        >
          <Layer>
            <Rect
              x={0}
              y={0}
              width={layout.canvas.width_pt}
              height={layout.canvas.height_pt}
              fill="#ffffff"
            />
            {background && (
              <KonvaImage
                image={background}
                x={0}
                y={0}
                width={layout.canvas.width_pt}
                height={layout.canvas.height_pt}
                listening={false}
              />
            )}

            {layout.elements.map((element) => (
              <ElementNode
                key={element.id}
                element={element}
                data={data}
                assetUrl={assetUrl}
                showBox={showBoxes || selectedId === element.id}
                register={(node) => {
                  if (node) nodes.current.set(element.id, node);
                  else nodes.current.delete(element.id);
                }}
                draggable={canEdit}
                onSelect={() => onSelect(element.id)}
                onDragEnd={(node) =>
                  onChange(element.id, { x: round(node.x()), y: round(node.y()) })
                }
                onTransformEnd={(node) => commitTransform(element, node)}
              />
            ))}

            <Transformer
              ref={transformerRef}
              // A viewer can select an element to read its properties, but
              // the handles move nothing (spec/v3.md §28).
              rotateEnabled={canEdit}
              resizeEnabled={canEdit}
              flipEnabled={false}
              // Handles are drawn in stage space, so they shrink with the zoom
              // unless they are scaled back up — at a 0.5 fit they become too
              // small to grab.
              anchorSize={8 / (scale || 1)}
              borderStrokeWidth={1 / (scale || 1)}
              anchorStrokeWidth={1 / (scale || 1)}
              rotateAnchorOffset={20 / (scale || 1)}
              boundBoxFunc={(oldBox, newBox) =>
                newBox.width < 4 || newBox.height < 4 ? oldBox : newBox
              }
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function ElementNode({
  element,
  data,
  assetUrl,
  showBox,
  register,
  draggable,
  onSelect,
  onDragEnd,
  onTransformEnd,
}: {
  draggable: boolean;
  element: LayoutElement;
  data: TicketData;
  assetUrl: (src: string) => string;
  showBox: boolean;
  register: (node: Konva.Group | null) => void;
  onSelect: () => void;
  onDragEnd: (node: Konva.Group) => void;
  onTransformEnd: (node: Konva.Group) => void;
}) {
  const ref = useRef<Konva.Group>(null);

  useEffect(() => {
    register(ref.current);
    return () => register(null);
  }, [register]);

  return (
    <Group
      ref={ref}
      x={element.x}
      y={element.y}
      rotation={element.rotation}
      draggable={draggable}
      onMouseDown={onSelect}
      onTouchStart={onSelect}
      onDragEnd={(event) => onDragEnd(event.target as Konva.Group)}
      onTransformEnd={(event) => onTransformEnd(event.target as Konva.Group)}
    >
      {/*
        A transparent hit rectangle over the whole box, so an element is
        grabbable by its box rather than by its ink. Without it a text element
        whose binding resolves to an empty string — an unnamed guest, a venue
        nobody has filled in — has nothing to click and looks like it vanished.
      */}
      <Rect width={element.w} height={element.h} fill="transparent" />
      <ElementContent element={element} data={data} assetUrl={assetUrl} />
      {showBox && (
        <Rect
          width={element.w}
          height={element.h}
          stroke="#3b82f6"
          strokeWidth={0.5}
          dash={[3, 3]}
          listening={false}
        />
      )}
    </Group>
  );
}

function ElementContent({
  element,
  data,
  assetUrl,
}: {
  element: LayoutElement;
  data: TicketData;
  assetUrl: (src: string) => string;
}) {
  switch (element.type) {
    case 'RECT':
      return (
        <Rect
          width={element.w}
          height={element.h}
          fill={element.fill ?? undefined}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke ? element.stroke_width : 0}
          cornerRadius={element.radius}
        />
      );
    case 'TEXT':
      return <TextContent element={element} data={data} />;
    case 'QR':
      return <QrContent element={element} data={data} />;
    case 'IMAGE':
      return <ImageContent element={element} assetUrl={assetUrl} />;
  }
}

function TextContent({ element, data }: { element: TextElement; data: TicketData }) {
  const value = textOf(element, data);
  const fontSize = useMemo(() => shrinkToFit(element, value), [element, value]);

  return (
    <Text
      text={value}
      width={element.w}
      height={element.h}
      fontSize={fontSize}
      fontFamily={cssFont(element.font_family)}
      fontStyle={element.font_weight >= 600 ? 'bold' : 'normal'}
      fill={element.color}
      align={element.align}
      verticalAlign={element.valign}
      lineHeight={1.2}
      wrap={element.max_lines > 1 ? 'word' : 'none'}
      ellipsis={element.overflow === 'CLIP'}
      listening={false}
    />
  );
}

function QrContent({ element, data }: { element: QrElement; data: TicketData }) {
  const value = resolveBinding('attendee.qr_url', data);
  const image = useQrImage(element, value);
  const side = Math.min(element.w, element.h);

  return (
    <>
      {/*
        The opaque plate §10.4 requires under every QR, drawn here for the same
        reason it is drawn in the PDF: "the editor shows this plate so the layout
        is honest about the space it takes". An admin who cannot see it will lay
        artwork right up to the symbol and wonder why the ticket stopped
        scanning.
      */}
      <Rect width={side} height={side} fill="#ffffff" listening={false} />
      {image ? (
        <KonvaImage image={image} width={side} height={side} listening={false} />
      ) : (
        <Text
          text="QR"
          width={side}
          height={side}
          align="center"
          verticalAlign="middle"
          fontSize={Math.max(6, side / 6)}
          fill="#9ca3af"
          listening={false}
        />
      )}
    </>
  );
}

function ImageContent({
  element,
  assetUrl,
}: {
  element: Extract<LayoutElement, { type: 'IMAGE' }>;
  assetUrl: (src: string) => string;
}) {
  const image = useUrlImage(assetUrl(element.src));

  return image ? (
    <KonvaImage
      image={image}
      width={element.w}
      height={element.h}
      opacity={element.opacity}
      listening={false}
    />
  ) : (
    <Rect
      width={element.w}
      height={element.h}
      fill="#f3f4f6"
      stroke="#d1d5db"
      strokeWidth={0.5}
      listening={false}
    />
  );
}
