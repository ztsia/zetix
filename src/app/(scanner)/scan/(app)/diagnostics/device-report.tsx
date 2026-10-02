'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Check, Copy, Minus, X } from 'lucide-react';
import { createScanFeedback, supportsVibration } from '@/lib/checkin/feedback';
import { openCheckinStore } from '@/lib/checkin/store';
import { ScannerSignOutButton } from '../../sign-out-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * The device check (see `page.tsx` for why this exists).
 *
 * Split into what the browser can answer by itself and what only the person
 * holding the phone can. The second kind is not a lesser signal — "the tone was
 * inaudible with the ringer switch on silent" is the single most valuable line
 * this page can produce, and nothing but a human can produce it.
 */

type Verdict = 'yes' | 'no' | 'unknown';

type Check = { label: string; verdict: Verdict; detail: string };

export function DeviceReport({ operatorName }: { operatorName: string }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [felt, setFelt] = useState<Verdict>('unknown');
  const [heard, setHeard] = useState<Verdict>('unknown');
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [cameraNote, setCameraNote] = useState('Not tested yet');
  const [decodeMs, setDecodeMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const feedbackRef = useRef<ReturnType<typeof createScanFeedback> | null>(null);

  useEffect(() => {
    feedbackRef.current ??= createScanFeedback();
    void (async () => {
      setChecks(await inspect());
    })();
  }, []);

  const buzz = useCallback(() => {
    // Called directly rather than through the feedback module's `play`, so the
    // answer is about `navigator.vibrate` and nothing else.
    try {
      navigator.vibrate?.([60, 80, 60]);
    } catch {
      // Exposed but refused. The usher's answer below is what counts.
    }
  }, []);

  const beep = useCallback(async () => {
    await feedbackRef.current?.unlock();
    setAudioUnlocked(feedbackRef.current?.capabilities().audioUnlocked ?? false);
    feedbackRef.current?.play('admitted');
  }, []);

  const testCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setCameraNote('Starting…');
    const reader = new BrowserMultiFormatReader();
    const startedAt = performance.now();
    try {
      const controls = await reader.decodeFromVideoDevice(undefined, video, (decoded) => {
        if (!decoded) return;
        setDecodeMs(Math.round(performance.now() - startedAt));
        controls.stop();
        for (const track of (video.srcObject as MediaStream | null)?.getTracks() ?? []) {
          track.stop();
        }
        video.srcObject = null;
        setCameraNote('Decoded a code');
      });
      const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      const settings = track?.getSettings();
      setCameraNote(
        settings ? `Running at ${settings.width}×${settings.height}` : 'Running',
      );
    } catch (cause) {
      setCameraNote(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Permission refused'
          : 'Would not start',
      );
    }
  }, []);

  const summary = buildSummary({ operatorName, checks, felt, heard, audioUnlocked, cameraNote, decodeMs });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused. The textarea below is selectable by hand.
    }
  };

  return (
    <main className="flex flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Device check</h1>
          <p className="text-muted-foreground text-sm">
            Two taps and two questions. Send the summary at the bottom to whoever set up the
            scanner.
          </p>
        </div>
        <ScannerSignOutButton className="h-10 shrink-0" />
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          What this phone reports
        </h2>
        {checks.map((check) => (
          <Item key={check.label} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle className="text-sm">{check.label}</ItemTitle>
              <ItemDescription>{check.detail}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <VerdictBadge verdict={check.verdict} />
            </ItemActions>
          </Item>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          What only you can answer
        </h2>

        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">1. Vibration</p>
          <Button variant="outline" size="lg" className="h-12" onClick={buzz}>
            Buzz this phone
          </Button>
          <YesNo label="Did you feel it?" value={felt} onChange={setFelt} />
          {!supportsVibration() && (
            <p className="text-muted-foreground text-xs">
              This browser has no Vibration API — expected on every iPhone. Colour and sound
              carry the result there.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">2. Sound</p>
          <Button variant="outline" size="lg" className="h-12" onClick={beep}>
            Play the admitted tone
          </Button>
          <YesNo label="Did you hear it?" value={heard} onChange={setHeard} />
          <Alert>
            <AlertTitle>Try it with the ringer switch on silent</AlertTitle>
            <AlertDescription>
              On an iPhone the mute switch may silence this. If it does, and the phone also
              has no vibration, colour is the only signal that reaches you — which is worth
              knowing before the night rather than during it.
            </AlertDescription>
          </Alert>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">3. Camera</p>
          <Button variant="outline" size="lg" className="h-12" onClick={testCamera}>
            Start the camera
          </Button>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="bg-muted aspect-video w-full rounded-md object-cover"
          />
          <p className="text-muted-foreground text-xs">
            {cameraNote}
            {decodeMs !== null ? ` · first decode in ${decodeMs}ms` : ''}
          </p>
          <p className="text-muted-foreground text-xs">
            Point it at any QR code — a real printed ticket if you have one, in the light you
            expect at the door.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Send this
        </h2>
        <textarea
          readOnly
          value={summary}
          rows={12}
          aria-label="Device summary"
          className="bg-muted w-full rounded-md p-3 font-mono text-xs"
        />
        <Button size="lg" className="h-12" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy summary'}
        </Button>
      </section>
    </main>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (verdict === 'yes') return <Badge variant="secondary"><Check className="size-3" />Yes</Badge>;
  if (verdict === 'no') return <Badge variant="destructive"><X className="size-3" />No</Badge>;
  return <Badge variant="outline"><Minus className="size-3" />?</Badge>;
}

function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Verdict;
  onChange: (v: Verdict) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm">{label}</span>
      <Button
        size="sm"
        variant={value === 'yes' ? 'default' : 'outline'}
        onClick={() => onChange('yes')}
      >
        Yes
      </Button>
      <Button
        size="sm"
        variant={value === 'no' ? 'destructive' : 'outline'}
        onClick={() => onChange('no')}
      >
        No
      </Button>
    </div>
  );
}

/** Everything the browser will tell us without asking a person. */
async function inspect(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push({
    label: 'Browser',
    verdict: 'unknown',
    detail: navigator.userAgent,
  });

  checks.push({
    label: 'Vibration API',
    verdict: supportsVibration() ? 'yes' : 'no',
    detail: supportsVibration()
      ? 'navigator.vibrate is available'
      : 'Not implemented — every browser on iOS is WebKit, so this is expected there',
  });

  const AudioCtor =
    'AudioContext' in window || 'webkitAudioContext' in window ? 'yes' : 'no';
  checks.push({
    label: 'Web Audio',
    verdict: AudioCtor as Verdict,
    detail: AudioCtor === 'yes' ? 'AudioContext can be created' : 'No AudioContext at all',
  });

  let storage: Verdict = 'no';
  let storageDetail = 'IndexedDB refused — the scan queue will not survive a reload';
  try {
    const store = await openCheckinStore();
    storage = store.durable ? 'yes' : 'no';
    storageDetail = store.durable
      ? 'IndexedDB works — the offline queue is safe'
      : 'Fell back to memory. Private browsing? The queue dies with the tab';
  } catch {
    // Leave the refusal above.
  }
  checks.push({ label: 'Offline storage', verdict: storage, detail: storageDetail });

  checks.push({
    label: 'Secure context',
    verdict: window.isSecureContext ? 'yes' : 'no',
    // Both the camera and crypto.subtle need it, so a "no" here means no
    // scanner at all rather than a degraded one.
    detail: window.isSecureContext
      ? 'HTTPS — camera and hashing available'
      : 'Not HTTPS. The camera and token hashing will both refuse to run',
  });

  const inset = getComputedStyle(document.documentElement).getPropertyValue(
    '--probe-safe-bottom',
  );
  checks.push({
    label: 'Viewport',
    verdict: 'unknown',
    detail: `${window.innerWidth}×${window.innerHeight}, dpr ${window.devicePixelRatio}${
      inset ? `, safe-area-bottom ${inset}` : ''
    }`,
  });

  checks.push({
    label: 'Installed as an app',
    verdict: window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no',
    detail: 'Standalone hides the URL bar, which changes the usable height',
  });

  return checks;
}

function buildSummary({
  operatorName,
  checks,
  felt,
  heard,
  audioUnlocked,
  cameraNote,
  decodeMs,
}: {
  operatorName: string;
  checks: Check[];
  felt: Verdict;
  heard: Verdict;
  audioUnlocked: boolean;
  cameraNote: string;
  decodeMs: number | null;
}): string {
  const lines = [
    `Device check — ${operatorName}`,
    new Date().toISOString(),
    '',
    ...checks.map((c) => `${c.label}: ${c.verdict.toUpperCase()} — ${c.detail}`),
    '',
    `Felt the buzz: ${felt.toUpperCase()}`,
    `Heard the tone: ${heard.toUpperCase()}`,
    `Audio unlocked: ${audioUnlocked ? 'YES' : 'NO'}`,
    `Camera: ${cameraNote}${decodeMs !== null ? ` (first decode ${decodeMs}ms)` : ''}`,
  ];

  if (felt === 'no' && heard === 'no') {
    lines.push(
      '',
      'WARNING: neither vibration nor sound reached this handset. Colour is the',
      'only channel here — this usher must be able to see the screen on every scan.',
    );
  }

  return lines.join('\n');
}
