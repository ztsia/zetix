'use client';

import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FormCard } from '@/components/forms/form-surface';
import { cn } from '@/lib/utils';

/**
 * The pieces of Google Forms' Settings tab: a card with a heading, groups inside
 * it that fold open and shut, and in each group a list of rows — what the
 * setting is and a line on what it does on the left, its control on the right.
 *
 * That shape is the point. A settings page of stacked labelled inputs asks the
 * reader to find the control; a row with the switch at the right-hand edge lets
 * them scan the words and see every state at once.
 */

/** A top-level settings card: "Settings", "Defaults". */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <FormCard className="flex flex-col gap-0 p-0">
      <div className="flex flex-col gap-1 border-b border-form-line px-6 py-5">
        <h2 className="text-lg leading-7">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <div className="flex flex-col divide-y divide-form-line px-6">{children}</div>
    </FormCard>
  );
}

/**
 * One group — "Responses", "Presentation" — that folds.
 *
 * **`keepMounted`, and it is load-bearing.** The groups sit inside one `<form>`
 * and are saved together; a folded group whose inputs had unmounted would post
 * nothing for them, and the save would read that as "cleared" and null the
 * setting. Folding is presentation, never an edit.
 */
export function SettingsGroup({
  title,
  description,
  defaultOpen = true,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/settings py-2">
      <CollapsibleTrigger className="hover:bg-muted/60 focus-visible:ring-form-accent -mx-3 flex w-[calc(100%+1.5rem)] items-center justify-between gap-4 rounded-md px-3 py-3 text-left focus-visible:ring-2 focus-visible:outline-none">
        <span className="flex flex-col gap-0.5">
          <span className="text-base">{title}</span>
          <span className="text-muted-foreground text-sm">{description}</span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-5 shrink-0 transition-transform group-data-[open]/settings:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="data-[closed]:hidden">
        <div className="flex flex-col gap-1 pb-3 sm:pl-8">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The small uppercase heading inside a group — "AFTER SUBMISSION". */
export function SettingsSubheading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground pt-4 pb-1 text-xs font-medium tracking-wider uppercase">
      {children}
    </p>
  );
}

/**
 * One setting: its name and what it does on the left, the control on the right.
 *
 * Stacks on a narrow screen, where a control squeezed beside two lines of hint
 * would be too small to use.
 */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm leading-5">
            {label}
          </label>
        ) : (
          <span className="text-sm leading-5">{label}</span>
        )}
        {hint ? <span className="text-muted-foreground text-sm leading-5">{hint}</span> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
