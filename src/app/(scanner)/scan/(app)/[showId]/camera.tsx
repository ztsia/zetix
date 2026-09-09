'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { CameraOff } from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * The viewfinder (spec/checkin.md §12.1, spec/surfaces.md §15.4).
 *
 * **The `<video>` element is mounted once and never torn down while the
 * scanner is open.** Everything about this file exists to protect that: the tab
 * panel keeps it mounted, the result draws over it, and the attendee sheet
 * portals above it. Re-acquiring a camera stream costs 1–3 seconds on
 * mid-range Android (ref.md §1.4).
 *
 * ## The iOS attributes are not optional
 *
 * `playsInline` is the one that decides whether this works at all on an iPhone.
 * Without it Safari takes any playing `<video>` fullscreen, which throws the
 * usher out of the scanner on the first frame. `muted` is what allows autoplay
 * without a gesture on both platforms, and `autoPlay` is what starts it.
 * `tests/checkin/ios-guards.test.ts` asserts all three are still here, because
 * the failure is invisible on every device we can test in CI and total on half
 * the ushers' phones.
 */
export function Camera({
  active,
  onDecode,
}: {
  /** False while the operator has not yet tapped "Start scanning". */
  active: boolean;
  onDecode: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const decodeRef = useRef(onDecode);
  const [error, setError] = useState<string | null>(null);

  // Kept in a ref so a changing callback identity never restarts the camera —
  // re-running the effect below is precisely the 1–3 second cost this file
  // exists to avoid. Synced in an effect rather than during render, because a
  // ref written during render is not a value React can reason about.
  useEffect(() => {
    decodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;

    let stopped = false;
    let controls: { stop: () => void } | undefined;
    const reader = new BrowserMultiFormatReader();

    void (async () => {
      try {
        controls = await reader.decodeFromVideoDevice(
          // `undefined` lets the library choose, and it prefers the rear camera
          // via the constraint below. Naming a deviceId would break on any
          // phone whose enumeration differs — which is all of them.
          undefined,
          video,
          (decoded) => {
            if (stopped || !decoded) return;
            decodeRef.current(decoded.getText());
          },
        );
      } catch (cause) {
        setError(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Camera permission was refused. Allow it in your browser settings, or use Search.'
            : 'This device would not start its camera. Search still works.',
        );
      }
    })();

    return () => {
      stopped = true;
      controls?.stop();
      // Belt and braces: stop every track directly. A `controls.stop()` that
      // silently failed would leave the camera light on after the usher
      // navigates away, which reads as the app spying on them.
      const stream = video.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) track.stop();
      }
      video.srcObject = null;
    };
  }, [active]);

  if (error) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CameraOff />
          </EmptyMedia>
          <EmptyTitle>No camera</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <video
      ref={videoRef}
      // Do not remove any of these three — see the note above.
      playsInline
      muted
      autoPlay
      data-slot="scanner-video"
      className="h-full w-full object-cover"
    />
  );
}
