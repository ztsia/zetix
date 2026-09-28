'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { saveFormSettingsAction } from '../actions';
import {
  SettingRow,
  SettingsCard,
  SettingsGroup,
  SettingsSubheading,
} from './settings/settings-layout';
import { AdminOnly } from '@/components/auth/role';

/**
 * The form's own settings — its window, its limits and its copy (spec/v2.md
 * §8.3), laid out as Google Forms' Settings tab: groups that fold, and a row per
 * setting with its control at the right.
 *
 * **What is not on this screen is the point of it.** Party size, base quota,
 * extra rows and the claim deadline are *segment* values (`domain.md` §6) and
 * they resolve through the cascade, so they appear below this card as read-only
 * facts with a link to where they are set. Offering them as inputs would write a
 * fifth cascade level that `resolve_setting()` does not have — and the admin
 * would have configured something that nothing reads (`party-cap.ts`, decision
 * 43).
 *
 * **The title and introduction are edited on the Questions tab**, in the header
 * card above the first question, as on Google Forms, and this save does not
 * touch them — so a Settings tab left open cannot undo a newer title.
 */

export function FormSettings({
  concertId,
  formId,
  defaults,
  timeZone,
}: {
  concertId: number;
  formId: number;
  defaults: {
    roundLabel: string | null;
    slug: string;
    confirmationMessageMd: string | null;
    opensAt: string;
    closesAt: string;
    allowEditUntil: string;
    maxResponses: number | null;
    oneResponsePerIdentity: boolean;
    autoCloseOnCapacity: boolean;
    waitlistWhenFull: boolean;
  };
  timeZone: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingConfirmation, setEditingConfirmation] = useState(false);
  const [confirmation, setConfirmation] = useState(defaults.confirmationMessageMd ?? '');
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await saveFormSettingsAction(concertId, formId, { error: null }, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setMessage(result.message ?? 'Saved.');
      setEditingConfirmation(false);
      router.refresh();
    });
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      {!timeZone && (
        <Alert variant="destructive">
          <AlertTitle>This concert has no timezone</AlertTitle>
          <AlertDescription>
            A form window is read against the venue&rsquo;s clock, so it cannot be stored
            until the concert has a zone. Set one on the concert first.
          </AlertDescription>
        </Alert>
      )}

      <SettingsCard title="Settings">
        <SettingsGroup
          title="Responses"
          description="Manage how responses are collected and protected"
        >
          <SettingRow
            label="Limit to 1 response per person"
            hint="Keyed on the player link, or the email address. Someone returning edits their answer rather than starting a second one."
            htmlFor={`${id}-identity`}
          >
            <Switch
              id={`${id}-identity`}
              name="oneResponsePerIdentity"
              defaultChecked={defaults.oneResponsePerIdentity}
            />
          </SettingRow>

          <SettingRow
            label="Maximum responses"
            hint={
              <>
                Blank for no limit. This caps <em>responses</em>, not seats — capacity is the
                segment&rsquo;s, and the allocation engine enforces it.
              </>
            }
            htmlFor={`${id}-max`}
          >
            <Input
              id={`${id}-max`}
              name="maxResponses"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="No limit"
              className="w-32"
              defaultValue={defaults.maxResponses ?? ''}
            />
          </SettingRow>

          <SettingRow
            label="Stop taking responses when the segment is full"
            htmlFor={`${id}-auto-close`}
          >
            <Switch
              id={`${id}-auto-close`}
              name="autoCloseOnCapacity"
              defaultChecked={defaults.autoCloseOnCapacity}
            />
          </SettingRow>

          <SettingRow
            label="Take waitlist requests when the segment is full"
            hint="Instead of closing, the form stays open and says it is taking waitlist requests. Seats are offered first come first served as they free up."
            htmlFor={`${id}-waitlist`}
          >
            <Switch
              id={`${id}-waitlist`}
              name="waitlistWhenFull"
              defaultChecked={defaults.waitlistWhenFull}
            />
          </SettingRow>

          <SettingsSubheading>Response editing</SettingsSubheading>
          <SettingRow
            label="Allow changes until"
            hint="Blank leaves changes open with no end date. A change may correct or reduce a party, never add seats."
            htmlFor={`${id}-edit-until`}
          >
            <Input
              id={`${id}-edit-until`}
              name="allowEditUntil"
              type="datetime-local"
              className="w-56"
              defaultValue={defaults.allowEditUntil}
              disabled={!timeZone}
            />
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          title="Schedule"
          description={
            timeZone
              ? `When the form takes responses, on the venue's clock (${timeZone})`
              : 'Set a concert timezone before entering times'
          }
        >
          <SettingRow
            label="Opens"
            hint="Blank opens it the moment it is published."
            htmlFor={`${id}-opens`}
          >
            <Input
              id={`${id}-opens`}
              name="opensAt"
              type="datetime-local"
              className="w-56"
              defaultValue={defaults.opensAt}
              disabled={!timeZone}
            />
          </SettingRow>
          <SettingRow
            label="Closes"
            hint="Blank keeps it open until you stop responses."
            htmlFor={`${id}-closes`}
          >
            <Input
              id={`${id}-closes`}
              name="closesAt"
              type="datetime-local"
              className="w-56"
              defaultValue={defaults.closesAt}
              disabled={!timeZone}
            />
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          title="Presentation"
          description="Manage how the form and responses are presented"
        >
          <SettingsSubheading>After submission</SettingsSubheading>
          {/*
            Google Forms shows the message in italics with an Edit link beside
            it, rather than a textarea that is always open; most forms never
            change it. The textarea is always in the DOM — hidden until Edit —
            so the save posts whatever is there either way.
          */}
          <SettingRow
            label="Confirmation message"
            hint={
              editingConfirmation ? null : (
                <span className="italic">
                  {confirmation || 'Your registration has been recorded.'}
                </span>
              )
            }
          >
            {!editingConfirmation && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-form-accent"
                onClick={() => setEditingConfirmation(true)}
              >
                Edit
              </Button>
            )}
          </SettingRow>
          <Textarea
            id={`${id}-confirmation`}
            name="confirmationMessageMd"
            aria-label="Confirmation message"
            rows={3}
            hidden={!editingConfirmation}
            value={confirmation}
            placeholder="Shown after a successful submission, above the seats granted."
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Link and round"
          description="Where the form lives, and how rounds on one segment are told apart"
        >
          <SettingRow
            label="Link"
            hint={
              <>
                <code className="text-xs">/f/{defaults.slug}</code> — unique across every
                concert. Changing it breaks any link already shared.
              </>
            }
            htmlFor={`${id}-slug`}
          >
            <Input
              id={`${id}-slug`}
              name="slug"
              required
              className="w-56"
              defaultValue={defaults.slug}
            />
          </SettingRow>
          <SettingRow label="Round" hint="Round 1, Round 2 …" htmlFor={`${id}-round`}>
            <Input
              id={`${id}-round`}
              name="roundLabel"
              className="w-56"
              defaultValue={defaults.roundLabel ?? ''}
              placeholder="Round 1"
            />
          </SettingRow>
        </SettingsGroup>

        <div className="flex flex-wrap items-center justify-end gap-3 py-4">
          {error && (
            <p role="alert" className="text-destructive mr-auto text-sm whitespace-pre-wrap">
              {error}
            </p>
          )}
          {message && !error && (
            <p role="status" className="text-muted-foreground mr-auto text-sm">
              {message}
            </p>
          )}
          <AdminOnly>
            <Button
              type="submit"
              disabled={isPending}
            >
              {isPending ? <Spinner /> : <Save />}
              {isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </AdminOnly>
        </div>
      </SettingsCard>
    </form>
  );
}
