'use client';

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  MousePointerSquareDashed,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  BINDINGS,
  DATE_BINDINGS,
  EC_LEVELS,
  OVERFLOW_MODES,
  type Binding,
  type LayoutElement,
} from '@/lib/tickets/layout';

/**
 * The properties panel (spec/tickets.md §10.3).
 *
 * **The binding picker is a `Select` over a closed list, never a text field.**
 * §10.2 says bindings are "picked from a list, never free-typed", and the reason
 * is §10.6: a bound field that changes after sending flags `needs_reissue`, and
 * that check works by knowing exactly which fields a layout binds. A free-typed
 * binding would fall outside it silently — the ticket in someone's inbox would
 * drift from the data with nothing to notice.
 */

/** How each binding reads to an admin who has never seen the jsonb. */
const BINDING_LABELS: Record<Binding, string> = {
  'attendee.full_name': 'Attendee name',
  'attendee.ticket_code': 'Ticket code',
  'attendee.qr_url': 'QR link',
  'registration.contact_name': 'Booked by',
  'player.full_name': 'Player name',
  'player.instrument': 'Player instrument',
  'show.name': 'Show name',
  'show.starts_at': 'Show date and time',
  'show.doors_open_at': 'Doors open',
  'show.venue_name': 'Venue',
  'show.venue_address': 'Venue address',
  'concert.name': 'Concert name',
};

const STATIC_TEXT = '__static__';

export function ElementProperties({
  element,
  onChange,
  onRemove,
  onReorder,
}: {
  element: LayoutElement | null;
  onChange: (patch: Partial<LayoutElement>) => void;
  onRemove: () => void;
  onReorder: (direction: 'FRONT' | 'BACK') => void;
}) {
  if (!element) {
    return (
      <Empty className="border-none">
        <MousePointerSquareDashed className="text-muted-foreground size-6" aria-hidden />
        <EmptyTitle>Nothing selected</EmptyTitle>
        <EmptyDescription>
          Click an element on the ticket to move, resize or restyle it.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <FieldGroup className="gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{element.type}</span>
          <span className="text-muted-foreground font-mono text-xs">{element.id}</span>
        </div>
        <ButtonGroup>
          <Button
            variant="outline"
            size="icon"
            aria-label="Bring to front"
            onClick={() => onReorder('FRONT')}
          >
            <ArrowUpToLine />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Send to back"
            onClick={() => onReorder('BACK')}
          >
            <ArrowDownToLine />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Delete element"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </ButtonGroup>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField label="X" value={element.x} onChange={(x) => onChange({ x })} />
        <NumberField label="Y" value={element.y} onChange={(y) => onChange({ y })} />
        <NumberField
          label="Width"
          value={element.w}
          min={1}
          onChange={(w) => onChange({ w })}
        />
        <NumberField
          label="Height"
          value={element.h}
          min={1}
          onChange={(h) => onChange({ h })}
        />
        <NumberField
          label="Rotation"
          value={element.rotation}
          onChange={(rotation) => onChange({ rotation })}
        />
      </div>

      <FieldSeparator />

      {element.type === 'TEXT' && <TextFields element={element} onChange={onChange} />}
      {element.type === 'QR' && <QrFields element={element} onChange={onChange} />}
      {element.type === 'IMAGE' && <ImageFields element={element} onChange={onChange} />}
      {element.type === 'RECT' && <RectFields element={element} onChange={onChange} />}
    </FieldGroup>
  );
}

function TextFields({
  element,
  onChange,
}: {
  element: Extract<LayoutElement, { type: 'TEXT' }>;
  onChange: (patch: Partial<LayoutElement>) => void;
}) {
  const isDate = element.binding !== null && DATE_BINDINGS.includes(element.binding);

  return (
    <>
      <Field>
        <FieldLabel htmlFor="binding">Content</FieldLabel>
        <Select
          value={element.binding ?? STATIC_TEXT}
          onValueChange={(value) => {
            if (!value) return;
            if (value === STATIC_TEXT) {
              onChange({ binding: null, text: element.text ?? 'Text' });
            } else {
              const binding = value as Binding;
              onChange({
                binding,
                // A bound element must not keep stale static text: §10.2 makes
                // `text` meaningful only when `binding` is null, and leaving it
                // behind makes the stored layout say two different things.
                text: undefined,
                format: DATE_BINDINGS.includes(binding)
                  ? (element.format ?? 'EEE d MMM yyyy, HH:mm')
                  : undefined,
              });
            }
          }}
        >
          <SelectTrigger id="binding">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={STATIC_TEXT}>Fixed text</SelectItem>
            {BINDINGS.map((binding) => (
              <SelectItem key={binding} value={binding}>
                {BINDING_LABELS[binding]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          A variable is filled in per ticket. Fixed text is the same on every one.
        </FieldDescription>
      </Field>

      {element.binding === null && (
        <Field>
          <FieldLabel htmlFor="text">Text</FieldLabel>
          <Input
            id="text"
            value={element.text ?? ''}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <FieldDescription>
            {'Variables work here too: Doors {{show.doors_open_at}}'}
          </FieldDescription>
        </Field>
      )}

      {(isDate || element.text?.includes('{{')) && (
        <Field>
          <FieldLabel htmlFor="format">Date format</FieldLabel>
          <Input
            id="format"
            value={element.format ?? ''}
            placeholder="EEE d MMM yyyy, HH:mm"
            onChange={(event) => onChange({ format: event.target.value || undefined })}
          />
          <FieldDescription>
            Rendered in the concert&apos;s timezone, never the reader&apos;s.
          </FieldDescription>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="font">Font</FieldLabel>
          <Select
            value={element.font_family}
            onValueChange={(value) => value && onChange({ font_family: value })}
          >
            <SelectTrigger id="font">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/*
                The two faces the renderer embeds (`fonts.ts`). Offering a font
                the PDF cannot embed would look right on screen and fall back to
                something else on paper.
              */}
              <SelectItem value="Inter">Inter</SelectItem>
              <SelectItem value="JetBrains Mono">JetBrains Mono</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Size"
          value={element.font_size}
          min={1}
          step={0.5}
          onChange={(font_size) => onChange({ font_size })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="weight">Weight</FieldLabel>
          <Select
            value={String(element.font_weight)}
            onValueChange={(value) => value && onChange({ font_weight: Number(value) })}
          >
            <SelectTrigger id="weight">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="400">Regular</SelectItem>
              <SelectItem value="600">Semibold</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="colour">Colour</FieldLabel>
          <Input
            id="colour"
            type="color"
            className="h-9 p-1"
            value={element.color}
            onChange={(event) => onChange({ color: event.target.value })}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Alignment</FieldLabel>
        {/*
          Base UI's ToggleGroup is always multi-value, so single-select is one
          entry in, one entry out — the pattern the import screen already uses.
          An empty set means the pressed item was deselected, and text has to be
          aligned somehow, so that is a no-op rather than an alignment of none.
        */}
        <ToggleGroup
          variant="outline"
          value={[element.align]}
          onValueChange={(value) => {
            const align = (value as string[])[0] as 'left' | 'center' | 'right' | undefined;
            if (align) onChange({ align });
          }}
        >
          <ToggleGroupItem value="left" aria-label="Align left">
            <AlignLeft />
          </ToggleGroupItem>
          <ToggleGroupItem value="center" aria-label="Align centre">
            <AlignCenter />
          </ToggleGroupItem>
          <ToggleGroupItem value="right" aria-label="Align right">
            <AlignRight />
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="valign">Vertical</FieldLabel>
          <Select
            value={element.valign}
            onValueChange={(value) =>
              value && onChange({ valign: value as 'top' | 'middle' | 'bottom' })
            }
          >
            <SelectTrigger id="valign">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="top">Top</SelectItem>
              <SelectItem value="middle">Middle</SelectItem>
              <SelectItem value="bottom">Bottom</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Max lines"
          value={element.max_lines}
          min={1}
          onChange={(max_lines) => onChange({ max_lines })}
        />
      </div>

      <Field>
        <FieldLabel htmlFor="overflow">If it does not fit</FieldLabel>
        <Select
          value={element.overflow}
          onValueChange={(value) =>
            value && onChange({ overflow: value as (typeof OVERFLOW_MODES)[number] })
          }
        >
          <SelectTrigger id="overflow">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SHRINK">Shrink the text</SelectItem>
            <SelectItem value="CLIP">Cut it off</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          Shrink keeps an unusually long name inside the design instead of over the QR.
        </FieldDescription>
      </Field>
    </>
  );
}

function QrFields({
  element,
  onChange,
}: {
  element: Extract<LayoutElement, { type: 'QR' }>;
  onChange: (patch: Partial<LayoutElement>) => void;
}) {
  return (
    <>
      <FieldDescription>
        The QR always carries the attendee&apos;s own link, and is drawn on an opaque plate so
        it scans over any artwork. Keep it at least 25 mm (71 pt) across.
      </FieldDescription>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="ec">Error correction</FieldLabel>
          <Select
            value={element.ec_level}
            onValueChange={(value) =>
              value && onChange({ ec_level: value as (typeof EC_LEVELS)[number] })
            }
          >
            <SelectTrigger id="ec">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EC_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Quiet zone"
          value={element.margin_modules}
          min={1}
          onChange={(margin_modules) => onChange({ margin_modules })}
        />
      </div>
    </>
  );
}

function ImageFields({
  element,
  onChange,
}: {
  element: Extract<LayoutElement, { type: 'IMAGE' }>;
  onChange: (patch: Partial<LayoutElement>) => void;
}) {
  return (
    <>
      <Field>
        <FieldLabel>File</FieldLabel>
        <p className="text-muted-foreground truncate font-mono text-xs">{element.src}</p>
      </Field>
      <NumberField
        label="Opacity"
        value={element.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(opacity) => onChange({ opacity })}
      />
    </>
  );
}

function RectFields({
  element,
  onChange,
}: {
  element: Extract<LayoutElement, { type: 'RECT' }>;
  onChange: (patch: Partial<LayoutElement>) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="fill">Fill</FieldLabel>
          <Input
            id="fill"
            type="color"
            className="h-9 p-1"
            value={element.fill ?? '#d8d4cc'}
            onChange={(event) => onChange({ fill: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="stroke">Border</FieldLabel>
          <Input
            id="stroke"
            type="color"
            className="h-9 p-1"
            value={element.stroke ?? '#1a1a1a'}
            onChange={(event) => onChange({ stroke: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Border width"
          value={element.stroke_width}
          min={0}
          step={0.5}
          onChange={(stroke_width) => onChange({ stroke_width })}
        />
        <NumberField
          label="Corner radius"
          value={element.radius}
          min={0}
          onChange={(radius) => onChange({ radius })}
        />
      </div>
    </>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          // An empty input parses as 0, and a NaN would propagate into the
          // layout and fail the schema on save with a message pointing at the
          // element rather than at the keystroke.
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </Field>
  );
}
