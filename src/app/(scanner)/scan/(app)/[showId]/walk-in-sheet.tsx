'use client';

import { useState } from 'react';
import { Minus, Plus, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * Record a walk-in: people admitted with no ticket and no roster row
 * (spec/v3.md §32.2). A headcount and, optionally, a name or a note — "no name
 * is OK".
 *
 * The largest headcount one tap may record is a setting, `checkin.walk_in_max_
 * headcount`, never a constant here. Being at capacity warns and never blocks,
 * like every signal at the door (§12.1).
 */
export function WalkInSheet({
  open,
  onOpenChange,
  maxHeadcount,
  initialLabel,
  atCapacity,
  onRecord,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** From the cascade; null means no cap was set. */
  maxHeadcount: number | null;
  /** A name typed into Search before "Record as walk-in". */
  initialLabel: string;
  /** The last server figures say the hall is full, with when. */
  atCapacity: { asOf: string } | null;
  onRecord: (headcount: number, label: string | null) => Promise<void>;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
        {open && (
          <WalkInForm
            maxHeadcount={maxHeadcount}
            initialLabel={initialLabel}
            atCapacity={atCapacity}
            onCancel={() => onOpenChange(false)}
            onRecord={onRecord}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

function WalkInForm({
  maxHeadcount,
  initialLabel,
  atCapacity,
  onCancel,
  onRecord,
}: {
  maxHeadcount: number | null;
  initialLabel: string;
  atCapacity: { asOf: string } | null;
  onCancel: () => void;
  onRecord: (headcount: number, label: string | null) => Promise<void>;
}) {
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState(initialLabel);
  const [busy, setBusy] = useState(false);
  const atMax = maxHeadcount !== null && count >= maxHeadcount;

  const record = async () => {
    setBusy(true);
    try {
      await onRecord(count, label.trim() || null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle className="text-xl">Record a walk-in</DrawerTitle>
        <DrawerDescription>Someone you are letting in with no ticket.</DrawerDescription>
      </DrawerHeader>

      <div className="flex flex-col gap-4 px-4">
        <Field>
          <FieldLabel id="walk-in-count">How many people</FieldLabel>
          <ButtonGroup aria-labelledby="walk-in-count" className="w-full">
            <Button
              variant="outline"
              className="size-14"
              aria-label="One fewer"
              disabled={count <= 1}
              onClick={() => setCount((n) => Math.max(1, n - 1))}
            >
              <Minus />
            </Button>
            <ButtonGroupText
              className="h-14 flex-1 justify-center text-2xl font-semibold tabular-nums"
              aria-live="polite"
            >
              {count}
            </ButtonGroupText>
            <Button
              variant="outline"
              className="size-14"
              aria-label="One more"
              disabled={atMax}
              onClick={() => setCount((n) => n + 1)}
            >
              <Plus />
            </Button>
          </ButtonGroup>
          {atMax && (
            <FieldDescription>
              {maxHeadcount} is the most one walk-in records. Record a larger group in parts.
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="walk-in-label">Name or note (optional)</FieldLabel>
          <Input
            id="walk-in-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
            autoComplete="off"
            className="h-12 text-base"
            placeholder="No name is fine"
          />
        </Field>

        {atCapacity && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>The hall is at capacity</AlertTitle>
            <AlertDescription>
              As of {atCapacity.asOf}. Check with the desk before admitting more — this will still
              record them.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DrawerFooter>
        <Button size="lg" className="h-14 text-base" disabled={busy} onClick={record}>
          {busy && <Spinner />}
          Admit {count} walk-in{count === 1 ? '' : 's'}
        </Button>
        <Button size="lg" variant="outline" className="h-14 text-base" onClick={onCancel}>
          Cancel
        </Button>
      </DrawerFooter>
    </>
  );
}
