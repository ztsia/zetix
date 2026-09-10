'use client';

import * as React from 'react';
import { Check, CircleAlert, FileSpreadsheet, Loader2, Lock, Save, Upload } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemMedia, ItemTitle, ItemGroup } from '@/components/ui/item';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { defaultProfileFor } from '@/lib/import/template';
import { parseMappingProfile } from '@/lib/import/profile';
import { DryRunReport } from './dry-run-report';
import { PrepareStep } from './prepare-step';
import type { InspectResponse, PlanResponse } from './types';

export type SegmentOption = {
  segmentId: number;
  showId: number;
  segmentName: string;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  showName: string;
};

/**
 * The import flow (spec/import.md §9.6).
 *
 * Six steps, strictly linear, each gated on the one before. shadcn ships no
 * stepper, so the rail is an `ItemGroup` rather than a `Tabs` bar — a tab bar
 * would imply the steps are freely navigable, and they are not.
 *
 * **The file never leaves the browser between steps.** It is re-posted for
 * inspect, dry run and commit alike. The planner is pure, so the same bytes give
 * the same answer every time, and nothing has to expire or be cleaned up.
 */

const STEPS = [
  'Prepare your sheet',
  'Choose file and segment',
  'Sheet and header row',
  'Map columns',
  'Dry run',
  'Commit',
] as const;

type Mapping = {
  requested_at: string | null;
  contact_name: string | null;
  contact_email: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  allocation_type: string | null;
  group_key: string | null;
};

type AllocationMode = 'UNIFORM' | 'COLUMN';

export type PlayerMatchStrategy = 'EMAIL' | 'NAME' | 'NAME_FUZZY';

/**
 * Labels for the strategies, in one place because the trigger needs them too.
 *
 * Base UI's `Select.Value` renders the raw *value* unless it is given a function
 * to format it, so a control whose value and label differ shows `NAME_FUZZY` on
 * the trigger while the open list reads correctly. Every other Select on this
 * screen picks a spreadsheet column, where the value is the label, which is why
 * this is the first place it comes up.
 */
/**
 * Renders the sentinel these column pickers use for "nothing chosen".
 *
 * A Base UI `Select` has no empty value, so unmapped is carried as the string
 * `__none__` — and `Select.Value` renders the raw value, so the trigger read
 * literally `__none__` while the open list said "Not mapped". `placeholder` does
 * not cover it either: a sentinel *is* a selected value, so the placeholder
 * never shows.
 */
const columnValue = (label: string) => (v: string | null) =>
  v == null || v === '__none__' ? label : v;

const PLAYER_MATCH_LABELS: Record<PlayerMatchStrategy, string> = {
  NAME_FUZZY: 'Player name, close match',
  NAME: 'Player name, exact',
  EMAIL: 'Player email',
};

export function ImportFlow({
  concertId,
  segments,
  timeZone,
  playerEmails,
}: {
  concertId: number;
  segments: SegmentOption[];
  /** The concert's zone, never the viewer's (`CLAUDE.md`). */
  timeZone: string;
  /** Active players on this concert, and how many of them have an email. */
  playerEmails: { total: number; withEmail: number };
}) {
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [file, setFile] = React.useState<File | null>(null);
  const [segmentId, setSegmentId] = React.useState<string>('');
  const [inspect, setInspect] = React.useState<InspectResponse | null>(null);
  const [sheet, setSheet] = React.useState<string>('');
  const [headerRow, setHeaderRow] = React.useState<number>(1);
  const [mapping, setMapping] = React.useState<Mapping | null>(null);

  /**
   * An explicit player-matching choice, or `null` to follow the default below.
   *
   * Kept as an override rather than seeded into state, for the same reason
   * `effectiveMode` is derived: the default depends on `mapping`, which arrives
   * asynchronously from inspect, and state seeded from it would spend one render
   * holding a column that does not exist in this file.
   */
  const [playerMatchOverride, setPlayerMatchOverride] = React.useState<{
    column: string | null;
    strategy: PlayerMatchStrategy;
  } | null>(null);

  const [allocationMode, setAllocationMode] = React.useState<AllocationMode>('UNIFORM');
  const [uniformType, setUniformType] = React.useState<'BASE' | 'EXTRA'>('EXTRA');
  const [valueMap, setValueMap] = React.useState<Record<string, 'BASE' | 'EXTRA' | ''>>({});

  /**
   * Saved mapping profiles (§9.3). Round two of a concert should be a profile
   * picked from a list, not the same mapping done again from memory — a re-done
   * mapping is a chance to map a column differently from the first run, which is
   * how two rounds of one form end up disagreeing in the database.
   */
  const [profiles, setProfiles] = React.useState<
    { id: number; name: string; config: unknown }[]
  >([]);
  const [profileName, setProfileName] = React.useState('');
  const [saved, setSaved] = React.useState<string | null>(null);

  const [plan, setPlan] = React.useState<PlanResponse | null>(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [committed, setCommitted] = React.useState<PlanResponse | null>(null);

  const segment = segments.find((s) => String(s.segmentId) === segmentId) ?? null;
  const isPublic = segment?.audienceMode === 'PUBLIC';

  /**
   * §9.5: a `BASE` seat in a public segment is not refused by the engine, it is
   * silently waitlisted. So the control never offers it here, and the server
   * refuses it as well — the lock is the UI half of a rule that exists on both
   * sides because either alone is one edit away from being the only one.
   *
   * Derived rather than forced into state by an effect. Storing it would mean a
   * render where the segment is public but the mode has not caught up yet, and
   * that render is exactly the one that would build a profile saying `BASE`.
   */
  const effectiveMode: AllocationMode = isPublic ? 'UNIFORM' : allocationMode;
  const effectiveType: 'BASE' | 'EXTRA' = isPublic ? 'EXTRA' : uniformType;

  /**
   * How a row is tied back to a player (§9.3), for `PLAYER_INVITED` only.
   *
   * **Names, not email.** This screen used to hardcode `EMAIL` against the
   * contact email column, with no way to change it. That is the obvious choice
   * and it is the wrong one twice over: the player roster is loaded from a name
   * list and carries no addresses at all, so nothing can ever match; and even
   * with addresses, the person filling in the form is not necessarily the
   * player — a parent registering for a child would miss. The result was every
   * party blocking on PLAYER_NOT_MATCHED with nothing on the mapping screen
   * saying why.
   *
   * `NAME_FUZZY` is the measured recommendation for a form people type their own
   * names into (`local.md` §5h): trigrams are order- and whitespace-insensitive,
   * so a reordered or double-spaced full name still matches, while a genuinely
   * partial name falls below `import.fuzzy_match_threshold` and is flagged in
   * the dry run rather than guessed at.
   *
   * All three strategies stay selectable, because the engine and the profile
   * format support all three and a roster loaded from a system that does have
   * addresses would want `EMAIL`. It is simply no longer the default, and
   * choosing it against a roster with no addresses now says so.
   *
   * A null column means no matching at all. That is a real configuration rather
   * than an error — the parties import with no player attached, and are
   * therefore owed no base allocation.
   */
  const playerMatch: { column: string | null; strategy: PlayerMatchStrategy } =
    playerMatchOverride ?? { column: mapping?.contact_name ?? null, strategy: 'NAME_FUZZY' };

  const loadProfiles = React.useCallback(async (showId: number | null) => {
    try {
      const res = await fetch(`/api/import/profiles${showId ? `?showId=${showId}` : ''}`);
      if (res.ok) setProfiles((await res.json()).profiles ?? []);
    } catch {
      // A profile list that will not load is a convenience missing, not a
      // failure: the admin maps by hand exactly as they would have anyway.
    }
  }, []);

  async function saveProfile() {
    if (!profileName.trim() || !mapping) return;
    setSaved(null);
    const res = await fetch('/api/import/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: profileName.trim(),
        showId: segment?.showId ?? null,
        audience: segment?.audienceMode ?? null,
        config: JSON.parse(buildProfile()),
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not save that mapping.');
      return;
    }
    setSaved(profileName.trim());
    setProfileName('');
    void loadProfiles(segment?.showId ?? null);
  }

  /** Applies a saved profile over the current file's headers. */
  function applyProfile(id: string) {
    const found = profiles.find((p) => String(p.id) === id);
    if (!found) return;
    try {
      const parsedProfile = parseMappingProfile(found.config);
      setMapping({
        requested_at: parsedProfile.columns.requestedAt,
        contact_name: parsedProfile.columns.contactName,
        contact_email: parsedProfile.columns.contactEmail,
        attendee_name: parsedProfile.columns.attendeeName,
        attendee_email: parsedProfile.columns.attendeeEmail,
        allocation_type: parsedProfile.columns.allocationType,
        group_key: parsedProfile.columns.groupKey,
      });
      setPlayerMatchOverride(
        parsedProfile.playerMatch
          ? {
              column: parsedProfile.playerMatch.column,
              strategy: parsedProfile.playerMatch.strategy,
            }
          : // A saved profile with no player match said so deliberately, so it
            // has to survive being re-applied rather than falling back to the
            // suggestion.
            { column: null, strategy: 'EMAIL' },
      );
      if (parsedProfile.columns.allocationType) {
        setAllocationMode('COLUMN');
        const next: Record<string, 'BASE' | 'EXTRA' | ''> = {};
        for (const v of parsedProfile.allocationTypeValues.BASE) next[v] = 'BASE';
        for (const v of parsedProfile.allocationTypeValues.EXTRA) next[v] = 'EXTRA';
        setValueMap(next);
        void runInspectWithColumn(parsedProfile.columns.allocationType);
      } else {
        setAllocationMode('UNIFORM');
        setUniformType(parsedProfile.defaultAllocationType);
      }
    } catch {
      setError('That saved mapping could not be read.');
    }
  }

  async function post(action: 'inspect' | 'dry-run' | 'commit', extra: Record<string, string> = {}) {
    if (!file || !segmentId) return null;
    const body = new FormData();
    body.set('action', action);
    body.set('file', file);
    body.set('segmentId', segmentId);
    for (const [k, v] of Object.entries(extra)) body.set(k, v);

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/import', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'That did not work.');
        return null;
      }
      return json;
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runInspect(overrides: { sheet?: string; headerRow?: number } = {}) {
    const extra: Record<string, string> = {};
    if (overrides.sheet ?? sheet) extra.sheet = overrides.sheet ?? sheet;
    if (overrides.headerRow ?? (inspect ? headerRow : 0)) {
      extra.headerRow = String(overrides.headerRow ?? headerRow);
    }
    const json = (await post('inspect', extra)) as InspectResponse | null;
    if (!json) return null;
    setInspect(json);
    setSheet(json.sheet);
    setHeaderRow(json.headerRow);
    setMapping((current) => current ?? { ...json.suggested });
    return json;
  }

  function buildProfile() {
    const base = defaultProfileFor(effectiveType);
    const columns = { ...(mapping ?? base.columns) };
    if (effectiveMode === 'UNIFORM') columns.allocation_type = null;

    const values =
      effectiveMode === 'COLUMN'
        ? Object.entries(valueMap).reduce<{ BASE: string[]; EXTRA: string[] }>(
            (acc, [text, choice]) => {
              if (choice) acc[choice].push(text);
              return acc;
            },
            { BASE: [], EXTRA: [] },
          )
        : { BASE: [], EXTRA: [] };

    return JSON.stringify({
      sheet,
      header_row: headerRow,
      columns,
      player_match:
        segment?.audienceMode === 'PLAYER_INVITED' && playerMatch.column
          ? { column: playerMatch.column, strategy: playerMatch.strategy }
          : null,
      allocation_type_values: values,
      default_allocation_type: effectiveType,
    });
  }

  const mappingComplete = Boolean(mapping?.requested_at && mapping?.contact_name);
  /**
   * `[].every(...)` is `true`, so an empty value list used to let Continue pass
   * with nothing mapped at all — the vacuous case, and the one that reaches the
   * dry run with every row blocking on ALLOCATION_TYPE_UNMAPPED. A column read
   * has to have found at least one value before it counts as configured.
   */
  const allocationValues = inspect?.allocationValues ?? [];
  const allocationComplete =
    effectiveMode === 'UNIFORM' ||
    (Boolean(mapping?.allocation_type) &&
      allocationValues.length > 0 &&
      allocationValues.every((v) => valueMap[v]));

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Spreadsheet import</h1>
        <p className="text-muted-foreground text-sm">
          One run loads one segment. A show with both a public and a player-invited audience is
          loaded by running this twice, once per file.
        </p>
      </header>

      <ItemGroup className="grid gap-1 sm:grid-cols-3 lg:grid-cols-6">
        {STEPS.map((label, i) => (
          <Item
            key={label}
            variant={i === step ? 'outline' : 'muted'}
            size="sm"
            className={cn(i > step && 'opacity-50')}
          >
            <ItemMedia variant="icon">
              {i < step ? <Check className="size-4" /> : <span className="text-xs">{i + 1}</span>}
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-xs">{label}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>

      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          {step === 0 ? <PrepareStep concertId={concertId} /> : null}

          {step === 1 ? (
            <FieldGroup className="max-w-xl">
              <Field>
                <FieldLabel htmlFor="segment">Target segment</FieldLabel>
                <Select value={segmentId} onValueChange={(v) => setSegmentId(v ?? '')}>
                  <SelectTrigger id="segment">
                    <SelectValue placeholder="Choose the segment this file loads into" />
                  </SelectTrigger>
                  <SelectContent>
                    {segments.map((s) => (
                      <SelectItem key={s.segmentId} value={String(s.segmentId)}>
                        {s.showName} — {s.segmentName} ({s.audienceMode})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  After commit this database is the source of truth for these rows. There is no
                  rollback and no re-sync back to the spreadsheet.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="file">Spreadsheet</FieldLabel>
                <Input
                  id="file"
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setInspect(null);
                    setMapping(null);
                    setPlan(null);
                  }}
                />
                <FieldDescription>
                  .xlsx or .csv, one row per attendee. Up to 5MB.
                </FieldDescription>
              </Field>

              {segments.length === 0 ? (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertTitle>This concert has no segments yet</AlertTitle>
                  <AlertDescription>
                    Create a show and at least one segment before importing.
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          ) : null}

          {step === 2 && inspect ? (
            <div className="space-y-6">
              <FieldGroup className="max-w-xl">
                {inspect.sheets.length > 1 ? (
                  <Field>
                    <FieldLabel htmlFor="sheet">Sheet</FieldLabel>
                    <Select
                      value={sheet}
                      onValueChange={(v) => {
                        if (!v) return;
                        setSheet(v);
                        setMapping(null);
                        void runInspect({ sheet: v });
                      }}
                    >
                      <SelectTrigger id="sheet">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {inspect.sheets.map((s) => (
                          <SelectItem key={s.name} value={s.name}>
                            {s.name} ({s.rowCount} rows)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}

                <Field>
                  <FieldLabel htmlFor="headerRow">Header row</FieldLabel>
                  <Input
                    id="headerRow"
                    type="number"
                    min={1}
                    value={headerRow}
                    onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value) || 1))}
                    onBlur={() => {
                      setMapping(null);
                      void runInspect({ headerRow });
                    }}
                  />
                  <FieldDescription>
                    Detected automatically. The rows below are what the importer will read — check
                    them rather than trusting the guess.
                  </FieldDescription>
                </Field>
              </FieldGroup>

              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {inspect.headers.map((h) => (
                        <TableHead key={h} className="text-xs whitespace-nowrap">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inspect.sample.map((row, i) => (
                      <TableRow key={i}>
                        {inspect.headers.map((h) => (
                          <TableCell key={h} className="text-xs whitespace-nowrap">
                            {row[h] || <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground text-sm">
                {inspect.rowCount} data rows below the header.
              </p>
            </div>
          ) : null}

          {step === 3 && inspect && mapping ? (
            <div className="space-y-8">
              {profiles.length > 0 ? (
                <FieldSet>
                  <FieldLegend>Saved mappings</FieldLegend>
                  <FieldDescription>
                    Reuse the mapping from an earlier round rather than rebuilding it.
                  </FieldDescription>
                  <Select value={null} onValueChange={(v) => v && applyProfile(String(v))}>
                    <SelectTrigger className="mt-2 w-80">
                      <SelectValue placeholder="Apply a saved mapping" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldSet>
              ) : null}

              <FieldSet>
                <FieldLegend>Columns</FieldLegend>
                <FieldDescription>
                  Suggested from your headers. Every suggestion is shown for confirmation — nothing
                  is applied silently.
                </FieldDescription>
                <FieldGroup className="max-w-2xl">
                  {(
                    [
                      ['requested_at', 'Timestamp', true],
                      ['contact_name', 'Contact name', true],
                      ['contact_email', 'Contact email', false],
                      ['attendee_name', 'Attendee name', false],
                      ['attendee_email', 'Attendee email', false],
                      ['group_key', 'Group key (overrides grouping)', false],
                    ] as const
                  ).map(([key, label, required]) => (
                    <Field
                      key={key}
                      orientation="horizontal"
                      data-invalid={required && !mapping[key] ? true : undefined}
                    >
                      <FieldLabel htmlFor={key}>
                        {label}
                        {required ? <span className="text-destructive"> *</span> : null}
                      </FieldLabel>
                      <Select
                        value={mapping[key] ?? '__none__'}
                        onValueChange={(v) =>
                          setMapping({ ...mapping, [key]: v === '__none__' ? null : v })
                        }
                      >
                        <SelectTrigger id={key} className="w-64">
                          <SelectValue>{columnValue('Not mapped')}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Not mapped</SelectItem>
                          {inspect.headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ))}
                </FieldGroup>
                {!mapping.contact_email ? (
                  <Alert className="mt-4">
                    <CircleAlert />
                    <AlertTitle>No contact email mapped</AlertTitle>
                    <AlertDescription>
                      Without it, rows can only be grouped by an explicit group column. Every row
                      will otherwise become its own registration.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldSet>

              {!isPublic ? (
                <FieldSet>
                  <FieldLegend>Match to player</FieldLegend>
                  <FieldDescription>
                    A player-invited party is owed base seats through the player it belongs to, so
                    each row has to name one. Unmatched parties block the dry run rather than
                    importing with no entitlement.
                  </FieldDescription>

                  <FieldGroup className="mt-2 max-w-2xl">
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="player-match-column">Column to match on</FieldLabel>
                      <Select
                        value={playerMatch.column ?? '__none__'}
                        onValueChange={(v) =>
                          setPlayerMatchOverride({
                            ...playerMatch,
                            column: v === '__none__' ? null : v,
                          })
                        }
                      >
                        <SelectTrigger id="player-match-column" className="w-64">
                          <SelectValue>{columnValue('Do not match players')}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Do not match players</SelectItem>
                          {inspect.headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>

                    {playerMatch.column ? (
                      <Field orientation="horizontal">
                        <FieldLabel htmlFor="player-match-strategy">Compare it against</FieldLabel>
                        <Select
                          value={playerMatch.strategy}
                          onValueChange={(v) =>
                            setPlayerMatchOverride({
                              ...playerMatch,
                              strategy: v as PlayerMatchStrategy,
                            })
                          }
                        >
                          <SelectTrigger id="player-match-strategy" className="w-64">
                            <SelectValue>
                              {(v: PlayerMatchStrategy) => PLAYER_MATCH_LABELS[v]}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(
                              ['NAME_FUZZY', 'NAME', 'EMAIL'] as const
                            ).map((v) => (
                              <SelectItem key={v} value={v}>
                                {PLAYER_MATCH_LABELS[v]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : null}
                  </FieldGroup>

                  {playerMatch.column && playerMatch.strategy === 'EMAIL' &&
                  playerEmails.withEmail === 0 ? (
                    <Alert variant="destructive" className="mt-4">
                      <CircleAlert />
                      <AlertTitle>
                        No player on this concert has an email address, so nothing will match
                      </AlertTitle>
                      <AlertDescription>
                        All {playerEmails.total} active players were loaded without one. Every party
                        would block on &ldquo;no player matches&rdquo; and none of them would
                        import. Match on a name column instead, or add addresses to the player list
                        first.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {playerMatch.column === null ? (
                    <Alert className="mt-4">
                      <CircleAlert />
                      <AlertTitle>These parties will import with no player attached</AlertTitle>
                      <AlertDescription>
                        Base entitlement is counted per player, so a BASE seat with no player has
                        nothing to draw against and is waitlisted. Only choose this if every row
                        here is an EXTRA.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </FieldSet>
              ) : null}

              <FieldSet>
                <FieldLegend>Seat type</FieldLegend>
                <FieldDescription>
                  Every seat is either <strong>BASE</strong> — a player&rsquo;s allocated
                  entitlement — or <strong>EXTRA</strong>, requested from the shared pool.
                </FieldDescription>

                {isPublic ? (
                  <Alert className="mt-2">
                    <Lock />
                    <AlertTitle>This is a public segment, so every seat is EXTRA</AlertTitle>
                    <AlertDescription>
                      BASE seats exist only in a player-invited segment. Importing them here would
                      not fail — the allocation engine waitlists them silently — so the whole
                      audience would arrive with no confirmed seat and no error to show for it.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <RadioGroup
                    className="mt-4 max-w-2xl gap-3"
                    value={effectiveMode}
                    onValueChange={(v) => setAllocationMode(v as AllocationMode)}
                  >
                    {/* Choice cards: FieldLabel wrapping a Field, per the shadcn Field composition. */}
                    {/*
                      The label wraps the radio and its text only. Nesting the
                      dependent Select inside it makes the surrounding <label>
                      swallow the click and toggle the radio instead of opening
                      the menu — the control looks present and does nothing.
                    */}
                    <div className="rounded-lg border p-3">
                      <FieldLabel htmlFor="mode-uniform">
                        <Field orientation="horizontal">
                          <RadioGroupItem value="UNIFORM" id="mode-uniform" />
                          <div className="flex-1">
                            <div className="text-sm font-medium">Every row is the same type</div>
                            <FieldDescription>
                              Use this when the file is all allocated seats, or all extras.
                            </FieldDescription>
                          </div>
                        </Field>
                      </FieldLabel>
                      {effectiveMode === 'UNIFORM' ? (
                        <div className="mt-3 pl-7">
                          <Select
                            value={effectiveType}
                            onValueChange={(v) => v && setUniformType(v as 'BASE' | 'EXTRA')}
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="BASE">BASE — allocated</SelectItem>
                              <SelectItem value="EXTRA">EXTRA — from the pool</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-lg border p-3">
                      <FieldLabel htmlFor="mode-column">
                        <Field orientation="horizontal">
                          <RadioGroupItem value="COLUMN" id="mode-column" />
                          <div className="flex-1">
                            <div className="text-sm font-medium">Read it from a column</div>
                            <FieldDescription>
                              Map each value found in that column to BASE or EXTRA.
                            </FieldDescription>
                          </div>
                        </Field>
                      </FieldLabel>
                      {effectiveMode === 'COLUMN' ? (
                        <div className="mt-3 space-y-3 pl-7">
                              <Select
                                value={mapping.allocation_type ?? '__none__'}
                                onValueChange={(v) => {
                                  const col = v === '__none__' ? null : v;
                                  setMapping({ ...mapping, allocation_type: col });
                                  setValueMap({});
                                  if (col) void runInspectWithColumn(col);
                                }}
                              >
                                <SelectTrigger className="w-64">
                                  <SelectValue>{columnValue('Which column?')}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">Not mapped</SelectItem>
                                  {inspect.headers.map((h) => (
                                    <SelectItem key={h} value={h}>
                                      {h}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>

                              {/*
                                The distinct values actually present in the file,
                                not values typed from memory (§9.6). A value that
                                maps to nothing is visible here, and §9.4 makes it
                                blocking rather than a guess.
                              */}
                              {inspect.allocationValues.length > 0 ? (
                                <div className="space-y-2 rounded-md border p-3">
                                  <p className="text-muted-foreground text-xs">
                                    {inspect.allocationValues.length} distinct values in that
                                    column:
                                  </p>
                                  {inspect.allocationValues.map((value) => (
                                    <div key={value} className="flex items-center gap-3">
                                      <Badge variant="outline" className="min-w-32 justify-start">
                                        {value}
                                      </Badge>
                                      <Select
                                        value={valueMap[value] ?? ''}
                                        onValueChange={(v) =>
                                          setValueMap({
                                            ...valueMap,
                                            [value]: v as 'BASE' | 'EXTRA',
                                          })
                                        }
                                      >
                                        <SelectTrigger className="w-40">
                                          <SelectValue placeholder="Map to…" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="BASE">BASE</SelectItem>
                                          <SelectItem value="EXTRA">EXTRA</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                        </div>
                      ) : null}
                    </div>
                  </RadioGroup>
                )}
              </FieldSet>

              <FieldSet>
                <FieldLegend>Save this mapping</FieldLegend>
                <FieldDescription>
                  So round two is a profile picked from a list rather than this step done again.
                </FieldDescription>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="e.g. Google Form, player round"
                    className="w-80"
                  />
                  <Button
                    variant="outline"
                    disabled={!profileName.trim() || !mappingComplete}
                    onClick={() => void saveProfile()}
                  >
                    <Save />
                    Save
                  </Button>
                  {saved ? (
                    <span className="text-muted-foreground text-sm">Saved &ldquo;{saved}&rdquo;</span>
                  ) : null}
                </div>
              </FieldSet>
            </div>
          ) : null}

          {step === 4 && plan ? <DryRunReport plan={plan} timeZone={timeZone} /> : null}

          {step === 5 ? (
            committed?.outcome ? (
              <Alert>
                <Check />
                <AlertTitle>Imported</AlertTitle>
                <AlertDescription>
                  <p>
                    {committed.outcome.createdRegistrations} registrations and{' '}
                    {committed.outcome.createdAttendees} attendees created.{' '}
                    {committed.outcome.granted.base} base and {committed.outcome.granted.extra}{' '}
                    extra seats confirmed
                    {committed.outcome.granted.pending > 0
                      ? `, ${committed.outcome.granted.pending} held for review`
                      : ''}
                    {committed.outcome.granted.waitlisted > 0
                      ? `, ${committed.outcome.granted.waitlisted} waitlisted`
                      : ''}
                    .
                    {committed.outcome.skippedParties > 0
                      ? ` ${committed.outcome.skippedParties} parties were skipped.`
                      : ''}
                  </p>
                  <p className="mt-2">
                    Batch #{committed.outcome.batchId}. Corrections from here are made in the
                    registrations screen, not in the spreadsheet.
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner /> Committing…
              </div>
            )
          ) : null}
        </CardContent>

        <CardFooter className="flex items-center justify-between border-t pt-6">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy || step === 5}
          >
            Back
          </Button>

          <div className="flex items-center gap-2">
            {busy ? <Loader2 className="text-muted-foreground size-4 animate-spin" /> : null}

            {step === 0 ? <Button onClick={() => setStep(1)}>Continue</Button> : null}

            {step === 1 ? (
              <Button
                disabled={!file || !segmentId || busy}
                onClick={async () => {
                  const json = await runInspect();
                  if (json) setStep(2);
                }}
              >
                <Upload />
                Read the file
              </Button>
            ) : null}

            {step === 2 ? (
              <Button
                disabled={busy || !inspect}
                onClick={() => {
                  void loadProfiles(segment?.showId ?? null);
                  setStep(3);
                }}
              >
                Continue
              </Button>
            ) : null}

            {step === 3 ? (
              <Button
                disabled={busy || !mappingComplete || !allocationComplete}
                onClick={async () => {
                  const json = (await post('dry-run', {
                    profile: buildProfile(),
                  })) as PlanResponse | null;
                  if (json) {
                    setPlan(json);
                    setStep(4);
                  }
                }}
              >
                <FileSpreadsheet />
                Dry run
              </Button>
            ) : null}

            {step === 4 && plan ? (
              <AlertDialog>
                <AlertDialogTrigger render={<span />}>
                  <Button
                    disabled={
                      busy ||
                      plan.counts.parties === plan.parties.filter((p) => p.blocked).length ||
                      plan.findings.some(
                        (f) => f.rowNumber === undefined && f.level === 'BLOCKING',
                      )
                    }
                  >
                    Commit {plan.parties.filter((p) => !p.blocked).length} registrations
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>This cannot be undone</AlertDialogTitle>
                    <AlertDialogDescription>
                      {plan.parties.filter((p) => !p.blocked).length} registrations and{' '}
                      {plan.counts.seats} attendees will be created in{' '}
                      <strong>{segment?.segmentName}</strong>. There is no rollback and no re-sync:
                      after this, corrections are made here rather than in the spreadsheet.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-2">
                    <FieldLabel htmlFor="confirm">
                      Type <strong>{segment?.segmentName}</strong> to confirm
                    </FieldLabel>
                    <Input
                      id="confirm"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={confirmation.trim() !== segment?.segmentName}
                      onClick={async () => {
                        setStep(5);
                        const json = (await post('commit', {
                          profile: buildProfile(),
                          confirmation,
                        })) as PlanResponse | null;
                        if (json) setCommitted(json);
                        else setStep(4);
                      }}
                    >
                      Import
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </CardFooter>
      </Card>
    </div>
  );

  /** Re-inspects to fetch the distinct values of the chosen allocation column. */
  async function runInspectWithColumn(column: string) {
    const json = (await post('inspect', {
      sheet,
      headerRow: String(headerRow),
      allocationColumn: column,
    })) as InspectResponse | null;
    if (json) setInspect(json);
  }
}
