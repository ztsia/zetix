'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Send, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useCanEdit } from '@/components/auth/role';
import type { SegmentDelivery } from '@/lib/delivery/defaults';
import { saveSegmentDeliveryAction, segmentDeliveryAction } from './delivery-actions';

/**
 * A segment's delivery defaults (spec/v3.md §24.2): the ticket design and the
 * ticket email Send tickets starts from for this segment. "Inherit" leaves the
 * choice to the show and the concert (design) or to the audience (email); the
 * wizard can still change either for one send.
 */
export function SegmentDeliveryDialog({
  concertId,
  segmentId,
  segmentName,
}: {
  concertId: number;
  segmentId: number;
  segmentName: string;
}) {
  const router = useRouter();
  const canEdit = useCanEdit();
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<SegmentDelivery | null>(null);
  const [designId, setDesignId] = React.useState<number | null>(null);
  const [template, setTemplate] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function load() {
    setData(null);
    setError(null);
    const result = await segmentDeliveryAction(concertId, segmentId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setData(result.value);
    setDesignId(result.value.designId);
    setTemplate(result.value.ticketTemplate);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const result = await saveSegmentDeliveryAction(concertId, segmentId, { designId, ticketTemplate: template });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!canEdit) return null;

  const inheritedTemplate = data?.templates.find((t) => t.key === data.inherited.template)?.name ?? data?.inherited.template;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delivery defaults for ${segmentName}`}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Send />
        Delivery
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delivery defaults · {segmentName}</DialogTitle>
            <DialogDescription>
              What Send tickets starts from for this segment. Either can still be changed for one send.
            </DialogDescription>
          </DialogHeader>
          {!data && !error && <Skeleton className="h-32 w-full" />}
          {data && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-design`}>Ticket design</FieldLabel>
                <NativeSelect
                  id={`${id}-design`}
                  className="w-full"
                  value={designId === null ? '' : String(designId)}
                  onChange={(event) => setDesignId(event.target.value ? Number(event.target.value) : null)}
                >
                  <NativeSelectOption value="">
                    Inherit{data.inherited.designLabel ? ` — ${data.inherited.designLabel}` : ''}
                  </NativeSelectOption>
                  {data.designs.map((d) => (
                    <NativeSelectOption key={d.id} value={d.id}>
                      {d.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Pinned when a ticket is issued. A ticket already issued keeps its design until it is reissued.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-template`}>Ticket email</FieldLabel>
                <NativeSelect
                  id={`${id}-template`}
                  className="w-full"
                  value={template ?? ''}
                  onChange={(event) => setTemplate(event.target.value || null)}
                >
                  <NativeSelectOption value="">
                    For a {data.audienceMode === 'PUBLIC' ? 'public' : 'player-invited'} audience — {inheritedTemplate}
                  </NativeSelectOption>
                  {data.templates.map((t) => (
                    <NativeSelectOption key={t.key} value={t.key}>
                      {t.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </FieldGroup>
          )}
          {error && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!data || saving} onClick={() => void save()}>
              {saving && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
