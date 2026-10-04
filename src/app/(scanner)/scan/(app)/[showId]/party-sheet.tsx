'use client';

import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ManifestEntry, ManifestIndex } from '@/lib/checkin/manifest';
import { admittedKeys, firstCheckIn, type LocalCheckIn } from '@/lib/checkin/evaluate';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { formatDoorTime } from './format';

/** What the door would be overriding for one seat, or null when nothing. */
type Override = 'IN' | 'CANCELLED' | 'ON_HOLD' | 'NO_TICKET';

const OVERRIDE_REASON: Record<Exclude<Override, 'NO_TICKET'>, string> = {
  IN: 'Admitted again at the door',
  CANCELLED: 'Admitted at the door although cancelled',
  ON_HOLD: 'Admitted at the door although not confirmed',
};

/**
 * A party, as a bottom sheet: who is here, ticked (spec/v3.md §32.2).
 *
 * **A sheet and not a route change**, and ref.md calls this the single most
 * valuable detail in that document: the camera stays mounted behind it.
 *
 * Every member has a checkbox. Everyone not yet in, confirmed and ticketed, is
 * ticked to start with, so the common case — the whole family at the door — is
 * still one tap. A split party unticks who is not here.
 *
 * **Amber and red never hard-block, here as on the scan overlay** (§12.1).
 * Someone already in, cancelled, on hold or with no ticket can be ticked; the
 * button then reads "Admit anyway", and each such seat is recorded with why.
 */
export function PartySheet({
  entry,
  index,
  checkIns,
  timeZone,
  open,
  onOpenChange,
  onAdmit,
}: {
  /** Any member of the party; the sheet shows all of them. */
  entry: ManifestEntry | null;
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  timeZone: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdmit: (items: { entry: ManifestEntry; reason: string | null }[]) => Promise<void>;
}) {
  // Remounted per party (see the key below), so the defaults are computed once.
  return entry ? (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent className="max-h-[90svh] pb-[env(safe-area-inset-bottom)]">
        <PartyBody
          key={`${entry.registrationId}:${open}`}
          entry={entry}
          index={index}
          checkIns={checkIns}
          timeZone={timeZone}
          onClose={() => onOpenChange(false)}
          onAdmit={onAdmit}
        />
      </DrawerContent>
    </Drawer>
  ) : null;
}

function PartyBody({
  entry,
  index,
  checkIns,
  timeZone,
  onClose,
  onAdmit,
}: {
  entry: ManifestEntry;
  index: ManifestIndex;
  checkIns: readonly LocalCheckIn[];
  timeZone: string | null;
  onClose: () => void;
  onAdmit: (items: { entry: ManifestEntry; reason: string | null }[]) => Promise<void>;
}) {
  const members = useMemo(
    () => index.byRegistration.get(entry.registrationId) ?? [entry],
    [index, entry],
  );
  const inKeys = useMemo(() => admittedKeys(index, checkIns), [index, checkIns]);
  const live = useMemo(() => checkIns.filter((c) => !c.revertedAt), [checkIns]);

  const overrideOf = (m: ManifestEntry): Override | null => {
    if (inKeys.has(index.keyOf(m))) return 'IN';
    if (m.status === 'CANCELLED') return 'CANCELLED';
    if (m.status === 'WAITLIST' || m.status === 'PENDING_REVIEW') return 'ON_HOLD';
    if (!m.hasTicket) return 'NO_TICKET';
    return null;
  };

  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(members.filter((m) => overrideOf(m) === null).map((m) => index.keyOf(m))),
  );
  const [busy, setBusy] = useState(false);

  const chosen = members.filter((m) => ticked.has(index.keyOf(m)));
  const overriding = chosen.filter((m) => overrideOf(m) !== null);
  const seats = members.filter((m) => m.status !== 'CANCELLED');
  const named = members.find((m) => m.nameSource !== 'PLACEHOLDER');
  const label = named?.name ?? 'Party';

  const toggle = (key: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const admit = async () => {
    setBusy(true);
    try {
      await onAdmit(
        chosen.map((m) => {
          const override = overrideOf(m);
          return {
            entry: m,
            reason:
              override && override !== 'NO_TICKET'
                ? OVERRIDE_REASON[override]
                : chosen.length > 1
                  ? 'Admitted with party at the door'
                  : null,
          };
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const stateLine = (m: ManifestEntry): string => {
    const override = overrideOf(m);
    const code = m.ticketCode ? ` · ${m.ticketCode}` : '';
    switch (override) {
      case 'IN': {
        const first = firstCheckIn(m, index.keyOf(m), live);
        return first
          ? `In ${formatDoorTime(first.at, timeZone)}${first.operatorName ? ` · ${first.operatorName}` : ''}`
          : 'Already in';
      }
      case 'CANCELLED':
        return 'Cancelled — refer to desk';
      case 'ON_HOLD':
        return `Not confirmed — refer to desk${code}`;
      case 'NO_TICKET':
        return 'No ticket issued';
      default:
        return `Not yet in${code}`;
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle className="text-xl">{label}</DrawerTitle>
        <DrawerDescription>
          {entry.playerName ? `Guest of ${entry.playerName}` : (entry.segmentName ?? 'Public')}
          {seats.length > 1 ? ` · Party of ${seats.length}` : ''}
        </DrawerDescription>
      </DrawerHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup className="gap-2">
          {members.map((m, i) => {
            const key = index.keyOf(m);
            const override = overrideOf(m);
            return (
              <FieldLabel key={key} htmlFor={`seat-${key}`}>
                <Field orientation="horizontal" className="min-h-14 items-center">
                  <Checkbox
                    id={`seat-${key}`}
                    className="size-6"
                    checked={ticked.has(key)}
                    onCheckedChange={(on: boolean) => toggle(key, on)}
                  />
                  <FieldContent>
                    <FieldTitle className="text-base">
                      {m.nameSource === 'PLACEHOLDER' ? `Unnamed seat ${i + 1}` : m.name}
                    </FieldTitle>
                    <FieldDescription>{stateLine(m)}</FieldDescription>
                  </FieldContent>
                  {override === 'IN' ? (
                    <Badge variant="secondary">In</Badge>
                  ) : override === 'CANCELLED' ? (
                    <Badge variant="destructive">Cancelled</Badge>
                  ) : override === 'NO_TICKET' ? (
                    <Badge variant="outline">No ticket</Badge>
                  ) : override === 'ON_HOLD' ? (
                    <Badge variant="outline">On hold</Badge>
                  ) : null}
                </Field>
              </FieldLabel>
            );
          })}
        </FieldGroup>

        {overriding.length > 0 && (
          <Alert className="mt-3">
            <TriangleAlert />
            <AlertTitle>
              {overriding.length === 1
                ? '1 ticked seat needs a second look'
                : `${overriding.length} ticked seats need a second look`}
            </AlertTitle>
            <AlertDescription>
              Admitting them anyway is recorded with the reason — already in, cancelled, not
              confirmed or no ticket.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DrawerFooter>
        <Button
          size="lg"
          className="h-14 text-base"
          variant={overriding.length > 0 ? 'secondary' : 'default'}
          disabled={busy || chosen.length === 0}
          onClick={admit}
        >
          {busy && <Spinner />}
          {chosen.length === 0
            ? 'Tick who is here'
            : overriding.length > 0
              ? `Admit anyway (${chosen.length})`
              : `Admit ${chosen.length}`}
        </Button>
        <Button size="lg" variant="outline" className="h-14 text-base" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </>
  );
}
