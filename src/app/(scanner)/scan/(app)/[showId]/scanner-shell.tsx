'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  ChevronDown,
  LogIn,
  ScanLine,
  Search as SearchIcon,
  TriangleAlert,
  UserPlus,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { ManifestEntry } from '@/lib/checkin/manifest';
import { toLocalCheckIns } from '@/lib/checkin/store';
import { FLASH_MS } from '@/lib/checkin/feedback';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { useScanner } from './use-scanner';
import { Camera } from './camera';
import { ResultOverlay } from './result-overlay';
import { PartySheet } from './party-sheet';
import { SearchTab } from './search-tab';
import { StatsTab } from './stats-tab';
import { AccountMenu } from './account-menu';
import { SyncStatus } from './sync-status';
import { WalkInSheet } from './walk-in-sheet';
import { formatDoorTime } from './format';

/**
 * How long a green result stays up before clearing itself (ref.md §1.2, "~2s").
 *
 * Not an operational value in CLAUDE.md's sense — no capacity, quota, deadline
 * or cap from `context.md` is involved. It is an interaction constant, and it
 * is longer than the 800ms flash on purpose so the name is still readable once
 * the colour has gone.
 */
const RESULT_AUTO_DISMISS_MS = 2000;

/**
 * How often the Stats tab re-reads the house while it is open and online.
 * An interaction constant like the admin Door screen's `POLL_MS`, not a
 * capacity or a limit (`CLAUDE.md`).
 */
const STATS_POLL_MS = 15_000;

export type ShowSummary = {
  id: number;
  name: string;
  venueName: string | null;
  startsAt: string | null;
  doorsOpenAt: string | null;
  /**
   * Nullable, because `concerts.timezone` is. Never defaulted to a literal
   * here: a zone is an operational value and a wrong one prints the wrong door
   * time (`CLAUDE.md`). Nothing on this surface renders an absolute time yet;
   * whatever does must resolve it rather than assume one.
   */
  timezone: string | null;
};

/**
 * The scanner, whole (spec/surfaces.md §15.4, ref.md §1.1).
 *
 * The IA is Hi.Events' and it is borrowed because it has been through real
 * venue use: bottom tabs so everything the usher touches is thumb-reachable
 * while holding a phone and a stack of programmes, a persistent show pill so
 * admitting against the wrong show is visible before it happens, and detail in
 * a bottom sheet so the camera never unmounts. Structure borrowed, code written
 * fresh — Hi.Events is AGPL and nothing is copied (ref.md, decision 14).
 *
 * ## Why `keepMounted` is the load-bearing prop in this file
 *
 * `Tabs.Panel` unmounts a hidden panel by default. That would tear down the
 * `<video>` every time the operator glanced at Search, and re-acquiring a
 * camera stream costs 1–3 seconds on mid-range Android — with 400 people
 * arriving inside twenty minutes, that is the difference between a queue and a
 * crowd (ref.md §1.4). `keepMounted` on the scan panel is what makes the tab
 * bar free to use.
 */
export function ScannerShell({
  show,
  operatorId,
  operatorName,
  manifestExpiresAt,
  scanDebounceMs,
  canSwitchShows,
  walkIns: walkInConfig,
}: {
  show: ShowSummary;
  operatorId: string;
  operatorName: string;
  manifestExpiresAt: string | null;
  scanDebounceMs: number;
  /** False for an operator rostered on exactly one show (§12.1). */
  canSwitchShows: boolean;
  /** Null when the concert does not record walk-ins (spec/v3.md §32.5). */
  walkIns: { maxHeadcount: number | null } | null;
}) {
  const {
    state,
    index,
    muted,
    submitScan,
    admit,
    refresh,
    prepareSignOut,
    recordWalkIn,
    undoWalkIn,
    fetchStats,
    dismissResult,
    unlockAudio,
    setMuted,
    playTone,
  } = useScanner({
    showId: show.id,
    manifestExpiresAt,
    scanDebounceMs,
    operatorId,
    operatorName,
  });

  const [started, setStarted] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [selected, setSelected] = useState<ManifestEntry | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Which bottom tab is showing, so Search can take focus when it opens. */
  const [tab, setTab] = useState('scan');
  /** Bumped after an admission from Search: the query clears for the next guest. */
  const [searchReset, setSearchReset] = useState(0);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInLabel, setWalkInLabel] = useState('');

  /** The house, re-read while the Stats tab is open and there is signal. */
  useEffect(() => {
    if (tab !== 'stats' || !state.online) return;
    void fetchStats();
    const id = window.setInterval(() => void fetchStats(), STATS_POLL_MS);
    return () => window.clearInterval(id);
  }, [tab, state.online, fetchStats]);

  const openWalkIn = (label: string) => {
    setWalkInLabel(label);
    setWalkInOpen(true);
    // The capacity warning reads the latest figures, when there is signal.
    if (state.online) void fetchStats();
  };

  const stats = state.serverStats;
  const pendingWalkIns = state.walkIns.filter((w) => !w.syncedAt && !w.refusedAt);
  const refusedWalkIns = state.walkIns.filter((w) => !w.syncedAt && w.refusedAt);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localCheckIns = toLocalCheckIns(state.scans, index);

  /**
   * **"Start scanning" is what unlocks audio, and that is the whole reason it
   * exists** (§12.2). Browsers block sound until a user gesture and iOS starts
   * the AudioContext suspended, so creating it lazily on the first scan would
   * put it outside any gesture — and the symptom is the worst kind: the first
   * several scans are silent, and nobody notices until the queue is moving.
   */
  const start = useCallback(async () => {
    await unlockAudio();
    setStarted(true);
  }, [unlockAudio]);

  const showFlash = useCallback((tone: string) => {
    setFlash(tone);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  /**
   * **A green result dismisses itself; amber and red do not** (ref.md §1.2).
   *
   * Without this the overlay covers the viewfinder until someone taps "Next",
   * which is one tap per guest for all four hundred — and the tap happens with
   * a queue in front of the usher, so it is the tap that gets skipped. Amber
   * and red deliberately stay: those are the ones with something to read.
   */
  useEffect(() => {
    if (state.result?.outcome !== 'ADMITTED') return;
    const timer = setTimeout(() => dismissResult(), RESULT_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [state.result, dismissResult]);

  const handleDecode = useCallback(
    async (text: string) => {
      const result = await submitScan(text);
      // `null` means the debounce swallowed it — no colour, no sound, no row.
      if (result) showFlash(result.tone);
    },
    [submitScan, showFlash],
  );

  const toggleMute = () => setMuted(!muted);

  if (!state.ready) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div
      // `100svh`, never `100vh`. On iOS Safari `vh` is the *largest* viewport,
      // so a `100vh` shell puts the tab bar underneath the URL bar until the
      // user scrolls — and this page never scrolls. See tests/checkin/ios-guards.
      className="flex h-svh flex-col overflow-hidden"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {/* The show pill (ref.md §1.3). With three shows in a weekend an usher
            on the wrong one silently rejects every valid ticket, so which show
            is being admitted is never more than a glance away. Read-only when
            there is nowhere else to go — §12.1. */}
        {canSwitchShows ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-9 min-w-0 flex-1 justify-between"
            nativeButton={false}
            render={<Link href="/scan" aria-label={`${show.name} — switch show`} />}
          >
            <span className="truncate font-semibold">{show.name}</span>
            <ChevronDown className="opacity-70" />
          </Button>
        ) : (
          <div
            data-slot="show-pill"
            className="bg-secondary text-secondary-foreground flex h-9 min-w-0 flex-1 items-center rounded-md px-3"
          >
            <span className="truncate text-sm font-semibold">{show.name}</span>
          </div>
        )}

        <SyncStatus
          online={state.online}
          syncing={state.syncing}
          pending={state.summary.pending + pendingWalkIns.length}
          refused={state.refused}
          refusedWalkIns={refusedWalkIns}
          index={index}
          timeZone={show.timezone}
        />

        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute scan sounds' : 'Mute scan sounds'}
          aria-pressed={muted}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>

        <AccountMenu
          operatorName={operatorName}
          canSwitchShows={canSwitchShows}
          unsynced={state.summary.pending}
          onPrepareSignOut={prepareSignOut}
        />
      </header>

      {(state.warning || !state.durable || state.signedOut || state.othersWaiting.length > 0) && (
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-2">
          {state.signedOut && (
            // A session that expired mid-shift used to fail silently: a
            // "queued" badge that never cleared (spec/v3.md §32.2).
            <Alert variant="destructive">
              <LogIn />
              <AlertTitle>
                Signed out
                {state.summary.pending > 0
                  ? ` — sign in again to send ${state.summary.pending} queued`
                  : ''}
              </AlertTitle>
              <AlertDescription>
                <p>Scanning still works. Admissions wait on this phone until you sign in.</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-10"
                  nativeButton={false}
                  render={<a href={`/scan/login?next=${encodeURIComponent(`/scan/${show.id}`)}`} />}
                >
                  Sign in again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {state.othersWaiting.map((other) => (
            <Alert key={other.operatorName}>
              <TriangleAlert />
              <AlertTitle>
                {other.count} admission{other.count === 1 ? '' : 's'} from {other.operatorName}{' '}
                {other.count === 1 ? 'is' : 'are'} waiting
              </AlertTitle>
              <AlertDescription>
                Only {other.operatorName} can send them. Ask them to sign in on this phone.
              </AlertDescription>
            </Alert>
          ))}
          {state.warning && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Roster</AlertTitle>
              <AlertDescription>{state.warning}</AlertDescription>
            </Alert>
          )}
          {!state.durable && (
            <Alert variant="destructive">
              <AlertTitle>This device will not save your queue</AlertTitle>
              <AlertDescription>
                Storage is blocked — private browsing, most likely. Scanning works, but do not
                close this tab until everything has synced.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <Tabs
        value={tab}
        onValueChange={(next) => setTab(String(next))}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {/* Panels above, tab bar below: thumb-reachable, no hamburger. */}
        <div className="relative min-h-0 flex-1">
          <TabsContent
            value="scan"
            // The prop this whole screen depends on — see the note above.
            keepMounted
            className="absolute inset-0 bg-black data-[hidden]:pointer-events-none"
          >
            {started ? (
              <Camera active onDecode={handleDecode} />
            ) : (
              <StartPrompt onStart={start} />
            )}

            {walkInConfig && !state.result && (
              // Bottom of the viewfinder, where the thumb is; under the result
              // overlay, so it never competes with a scan's answer.
              <Button
                variant="secondary"
                size="lg"
                className="absolute right-4 bottom-4 z-10 h-14 px-5 text-base"
                onClick={() => openWalkIn('')}
              >
                <UserPlus />
                Walk-in
              </Button>
            )}

            {state.result && (
              <ResultOverlay
                result={state.result}
                timeZone={show.timezone}
                onDismiss={dismissResult}
                onOpenDetail={() => {
                  if (state.result?.entry) {
                    setSelected(state.result.entry);
                    setSheetOpen(true);
                  }
                }}
                onAdmitAnyway={async () => {
                  if (state.result?.entry) {
                    await admit([{ entry: state.result.entry, reason: 'Admitted at door over a warning' }]);
                    dismissResult();
                  }
                }}
              />
            )}
          </TabsContent>

          <TabsContent value="search" className="absolute inset-0">
            <SearchTab
              index={index}
              checkIns={localCheckIns}
              active={tab === 'search' && !sheetOpen && !walkInOpen}
              resetSignal={searchReset}
              onWalkIn={walkInConfig ? openWalkIn : undefined}
              onSelect={(entry) => {
                setSelected(entry);
                setSheetOpen(true);
              }}
            />
          </TabsContent>

          <TabsContent value="stats" className="absolute inset-0">
            <StatsTab
              stats={stats}
              online={state.online}
              timeZone={show.timezone}
              unsyncedAdmissions={state.summary.pending}
              unsyncedWalkIns={pendingWalkIns.reduce((n, w) => n + w.headcount, 0)}
              refused={state.summary.refused + refusedWalkIns.length}
              walkIns={state.walkIns}
              rosterFetchedAt={state.manifest?.fetchedAt ?? null}
              refreshing={state.refreshing}
              onRefresh={() => {
                void refresh();
                void fetchStats();
              }}
              onUndoWalkIn={(clientId) => void undoWalkIn(clientId)}
            />
          </TabsContent>
        </div>

        <TabsList
          variant="line"
          /**
           * `w-full` and the variant-prefixed height override are both load
           * bearing. `tabsListVariants` ships `w-fit` and
           * `group-data-horizontal/tabs:h-8`, and a bare `h-auto` does not beat
           * a variant-prefixed class — tailwind-merge treats them as different
           * keys, so both survive and the prefixed one wins. Without these the
           * bar renders 152×32px in the corner instead of a full-width row of
           * 64px targets, which a DOM snapshot shows as perfectly correct and a
           * thumb in a dark foyer does not.
           */
          className="h-auto w-full shrink-0 justify-around rounded-none border-t bg-transparent p-0 pb-[env(safe-area-inset-bottom)] group-data-horizontal/tabs:h-auto"
        >
          <BottomTab value="scan" icon={<ScanLine />} label="Scan" />
          <BottomTab value="search" icon={<SearchIcon />} label="Search" />
          <BottomTab value="stats" icon={<BarChart3 />} label="Stats" />
        </TabsList>
      </Tabs>

      {walkInConfig && (
        <WalkInSheet
          open={walkInOpen}
          onOpenChange={setWalkInOpen}
          maxHeadcount={walkInConfig.maxHeadcount}
          initialLabel={walkInLabel}
          atCapacity={
            stats?.capacity != null && stats.inHall >= stats.capacity
              ? { asOf: formatDoorTime(stats.asOf, show.timezone) }
              : null
          }
          onRecord={async (headcount, label) => {
            await recordWalkIn(headcount, label);
            setWalkInOpen(false);
            showFlash('admitted');
            if (tab === 'search') setSearchReset((n) => n + 1);
          }}
        />
      )}

      <PartySheet
        entry={selected}
        index={index}
        checkIns={localCheckIns}
        timeZone={show.timezone}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onAdmit={async (items) => {
          await admit(items);
          setSheetOpen(false);
          showFlash('admitted');
          playTone('admitted');
          if (tab === 'search') setSearchReset((n) => n + 1);
        }}
      />

      {/* The full-screen flash. Above the tabs and pointer-events-none, so it
          never eats the tap that follows it — an usher at speed taps "Next"
          before the 800ms is up. */}
      {flash && (
        <div
          aria-hidden
          data-flash={flash}
          className={`pointer-events-none fixed inset-0 z-50 animate-out fade-out duration-700 ${
            flash === 'admitted'
              ? 'bg-[var(--scan-admitted)]'
              : flash === 'duplicate'
                ? 'bg-[var(--scan-duplicate)]'
                : 'bg-[var(--scan-error)]'
          }`}
        />
      )}

      <p className="sr-only" aria-live="polite">
        Signed in as {operatorName}
      </p>
    </div>
  );
}

function BottomTab({
  value,
  icon,
  label,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      // 64px of vertical target. This is tapped one-handed, in the dark, by
      // someone holding something else in the other hand.
      className="h-16 flex-1 flex-col gap-1 rounded-none text-xs [&_svg:not([class*='size-'])]:size-6"
    >
      {icon}
      {label}
    </TabsTrigger>
  );
}

/**
 * The gesture that unlocks audio (§12.2).
 *
 * Full-bleed and unmissable, because it is also the moment the camera
 * permission prompt appears — an usher who taps past it in the dark has a
 * scanner with neither sound nor camera and no obvious way back.
 */
function StartPrompt({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <ScanLine className="text-muted-foreground size-16" />
      <div className="space-y-2">
        <p className="text-xl font-semibold">Ready at the door</p>
        <p className="text-muted-foreground text-sm">
          Starting turns on the camera and the scan sounds.
        </p>
      </div>
      <Button size="lg" className="h-16 w-full max-w-xs text-lg" onClick={onStart}>
        Start scanning
      </Button>
    </div>
  );
}
