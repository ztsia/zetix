'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
  type ValueAnimationTransition,
} from 'motion/react';
import {
  ChartNoAxesColumn,
  ChevronDown,
  CircleCheck,
  CircleUserRound,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
  TriangleAlert,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { createDoorSound, type DoorSound } from '../_lib/door-sound';
import { TIME_ZONE } from '../_lib/guest';
import { TEAR_STUB_TRANSFORM, TEAR_UPPER } from '../_lib/tear';
import { Plate } from './plate';

/** The ticket's QR, drawn on the server from its code. */
export type TicketQr = { path: string; size: number };

type Screen = 'ready' | 'reading' | 'admitted' | 'duplicate' | 'party';

/** The ticket is the mark: its QR sits in the upper half's right-hand column, here. */
const QR_AT = { x: 0.847, y: 0.459 };
const REST = -7;

/**
 * IV. The door, as an usher's phone sees it (spec/checkin.md §12). A working copy of the scanner's
 * result screen, not a picture of one: scan Eleanor's ticket and it admits her, scan it again and
 * it refuses, switch the signal off and it still admits, then syncs when the signal returns. Her
 * ticket is the Zetix mark, so the stub an usher would tear off is the mark's coral half.
 */
export function Door({ qr, children }: { qr: TicketQr; children?: React.ReactNode }) {
  const ticket = useRef<HTMLButtonElement>(null);
  const phone = useRef<HTMLDivElement>(null);
  const viewfinder = useRef<HTMLDivElement>(null);
  const audio = useRef<DoorSound | null>(null);
  const timers = useRef<number[]>([]);
  const reduce = useReducedMotion();

  const [screen, setScreen] = useState<Screen>('ready');
  const [admitted, setAdmitted] = useState(false);
  const [torn, setTorn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState(0);
  const [syncing, setSyncing] = useState(0);
  const [sound, setSound] = useState(false);
  const [firstScan, setFirstScan] = useState('');
  const [flash, setFlash] = useState(0);

  // Motion values rather than animated props: the sequence below re-renders the door at every
  // step, and these keep their place through it.
  const held = { x: useMotionValue(0), y: useMotionValue(0), rotate: useMotionValue(REST), scale: useMotionValue(1) };
  const body = { x: useMotionValue(0), y: useMotionValue(0), rotate: useMotionValue(0) };
  const stub = { x: useMotionValue(0), y: useMotionValue(0), rotate: useMotionValue(0), opacity: useMotionValue(1) };
  const shake = useMotionValue(0);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const pause = (ms: number) =>
    new Promise<void>((resolve) => timers.current.push(window.setTimeout(resolve, reduce ? 0 : ms)));

  async function scan() {
    if (busy || !ticket.current || !phone.current || !viewfinder.current) return;
    setBusy(true);
    setScreen('ready');
    const repeat = admitted;

    // Held up to the phone's camera: behind the phone, its QR on the camera's line of sight.
    const t = ticket.current;
    const p = phone.current;
    const v = viewfinder.current;
    const to = {
      x: p.offsetLeft + v.offsetLeft + v.offsetWidth / 2 - (t.offsetLeft + t.offsetWidth * QR_AT.x),
      y: p.offsetTop + v.offsetTop + v.offsetHeight / 2 - (t.offsetTop + t.offsetHeight * QR_AT.y),
    };
    if (!reduce) {
      await animateAll(held, { x: to.x, y: to.y, rotate: 0, scale: 0.84 }, { duration: 0.6, ease: [0.65, 0, 0.35, 1] });
    }
    setScreen('reading');
    await pause(420);

    setFlash((n) => n + 1);
    if (!online) setWaiting((n) => n + 1);
    if (repeat) {
      setScreen('duplicate');
      if (sound) audio.current?.duplicate();
      if (!reduce) animate(shake, [0, -10, 9, -6, 3, 0], { duration: 0.42 });
    } else {
      setScreen('admitted');
      setAdmitted(true);
      // In the concert's zone, as the guest's pages beside it are, never the visitor's.
      setFirstScan(
        new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIME_ZONE }).format(new Date()),
      );
      if (sound) audio.current?.admitted();
    }

    if (!reduce) {
      await animateAll(held, { x: 0, y: 0, rotate: REST, scale: 1 }, { type: 'spring', bounce: 0.22, visualDuration: 0.6 });
    }
    if (!repeat && !torn) {
      await pause(140);
      if (sound) audio.current?.tear();
      setTorn(true);
      if (reduce) {
        stub.opacity.set(0);
      } else {
        // The body jerks as the stub gives, then the stub drops away along the cut.
        const jolt = { duration: 0.55, ease: 'easeOut' } as const;
        animate(body.rotate, [0, -3, 0], jolt);
        animate(body.x, [0, -8, 0], jolt);
        animate(body.y, [0, -4, 0], jolt);
        const fall = { duration: 1.1, times: [0, 0.22, 1], ease: [0.45, 0, 0.9, 0.55] as const };
        await Promise.all([
          animate(stub.x, [0, 18, 64], fall),
          animate(stub.y, [0, 26, 340], fall),
          animate(stub.rotate, [0, 9, 34], fall),
          animate(stub.opacity, [1, 1, 0], fall),
        ]);
      }
    }
    setBusy(false);
  }

  async function reset() {
    if (busy) return;
    setScreen('ready');
    setAdmitted(false);
    setWaiting(0);
    setSyncing(0);
    if (torn) {
      setTorn(false);
      if (reduce) {
        stub.opacity.set(1);
      } else {
        setBusy(true);
        await animateAll(stub, { x: 0, y: 0, rotate: 0, opacity: 1 }, { type: 'spring', bounce: 0.3, visualDuration: 0.6 });
        setBusy(false);
      }
    }
  }

  function toggleSignal() {
    if (online) {
      setOnline(false);
      return;
    }
    setOnline(true);
    if (waiting > 0) {
      // The queue drains on reconnect, keeping each scan's own time (spec/checkin.md §12.3).
      setSyncing(waiting);
      setWaiting(0);
      timers.current.push(window.setTimeout(() => setSyncing(0), 1600));
    }
  }

  async function toggleSound() {
    if (sound) {
      setSound(false);
      return;
    }
    audio.current ??= createDoorSound();
    await audio.current.unlock();
    setSound(true);
    audio.current.tuning();
  }

  const verdict = screen === 'admitted' || screen === 'party' ? 'admitted' : screen === 'duplicate' ? 'duplicate' : null;
  const pill = !online
    ? { tone: 'offline', text: waiting ? `Offline · ${waiting} waiting` : 'Offline' }
    : syncing
      ? { tone: 'syncing', text: `Syncing ${syncing}` }
      : null;
  const announcement =
    screen === 'admitted'
      ? `Admitted: Eleanor Whitfield. Party of 3, 1 in, 2 remaining.${online ? '' : ' Saved on the phone until the signal returns.'}`
      : screen === 'party'
        ? 'Admitted: the rest of Eleanor Whitfield’s party. 3 in.'
        : screen === 'duplicate'
          ? `Already checked in: Eleanor Whitfield, first scanned at ${firstScan} by Aisyah.`
          : '';

  return (
    <section id="door" className="zx-door" data-cue="dark" aria-labelledby="zx-door-title">
      <div className="zx-wrap zx-door__grid">
        <div className="zx-door__intro">
          <p className="zx-chapter">
            <span className="zx-chapter__numeral">IV</span>
            <span className="zx-chapter__name">The door</span>
            <i className="zx-chapter__tempo">Adagio, senza segnale</i>
          </p>
          <Plate as="h2" size="lg" className="zx-door__title">
            <span id="zx-door-title">
              The door works with <em>no signal.</em>
            </span>
          </Plate>
          <p className="zx-door__body">
            Each usher&rsquo;s phone holds the show&rsquo;s roster. Scans are checked against it and queued,
            then sync when the signal comes back. A ticket can&rsquo;t be used twice.
          </p>
        </div>

        {/* After the stage on a phone, so the ticket and the scanner are in view when you press it. */}
        <div className="zx-door__panel">
          <div className="zx-door__controls">
            <button type="button" className="zx-btn zx-btn--admit" onClick={scan} disabled={busy}>
              <ScanLine aria-hidden className="zx-btn__icon" />
              {admitted ? 'Scan it again' : 'Scan Eleanor’s ticket'}
            </button>
            {(admitted || torn) && (
              <button type="button" className="zx-btn zx-btn--quiet" onClick={reset} disabled={busy}>
                <RotateCcw aria-hidden className="zx-btn__icon" />
                Reset
              </button>
            )}
          </div>

          <div className="zx-door__switches">
            <button type="button" role="switch" aria-checked={online} className="zx-switch" onClick={toggleSignal}>
              <span className="zx-switch__track" aria-hidden>
                <span className="zx-switch__thumb" />
              </span>
              <span className="zx-switch__label">Signal</span>
              <span className="zx-bars" data-off={online ? undefined : ''} aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
            </button>
            <button type="button" role="switch" aria-checked={sound} className="zx-switch" onClick={toggleSound}>
              <span className="zx-switch__track" aria-hidden>
                <span className="zx-switch__thumb" />
              </span>
              <span className="zx-switch__label">Sound</span>
            </button>
          </div>
          <p className="zx-door__tones">
            The admit chime is A5 rising to E6, the fifth that strings tune in. A repeat sounds A4, the
            note an orchestra tunes to.
          </p>
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>
        </div>

        <div className="zx-door__stage" data-torn={torn ? '' : undefined}>
          <motion.div
            key={flash}
            data-spill
            className="zx-door__spill"
            data-tone={verdict ?? undefined}
            initial={{ opacity: 0 }}
            animate={{ opacity: verdict ? [0, 1, 0.62] : 0 }}
            transition={{ duration: verdict ? 0.9 : 0.5, times: verdict ? [0, 0.12, 1] : undefined }}
            aria-hidden
          />

          {/* The ticket is a control too: on a phone, tapping it keeps it and the scanner in view. */}
          <motion.button
            ref={ticket}
            type="button"
            className="zx-ticket"
            style={{ ...held, transformOrigin: '84.7% 45.9%' }}
            onClick={scan}
            disabled={busy}
            aria-label={admitted ? 'Scan Eleanor’s ticket again' : 'Hold Eleanor’s ticket up to the scanner'}
          >
            <span className="zx-ticket__lift">
              <motion.span className="zx-ticket__half zx-ticket__half--body" style={body}>
                <svg viewBox="2 8 59 49" className="zx-ticket__shape" aria-hidden>
                  <path d={TEAR_UPPER} />
                </svg>
                <span className="zx-ticket__band">
                  <span className="zx-ticket__show">
                    <small>Autumn Serenade</small>
                    Gala evening
                  </span>
                  <span className="zx-ticket__guest">
                    Eleanor Whitfield
                    <small>Party of 3, doors 18:45</small>
                  </span>
                </span>
                <svg className="zx-ticket__qr" viewBox={`-1 -1 ${qr.size + 2} ${qr.size + 2}`} aria-hidden>
                  <rect x="-1" y="-1" width={qr.size + 2} height={qr.size + 2} className="zx-ticket__qr-ground" />
                  <path d={qr.path} />
                </svg>
              </motion.span>
              <motion.span className="zx-ticket__half zx-ticket__half--stub" style={{ ...stub, transformOrigin: '30% 80%' }}>
                <svg viewBox="2 8 59 49" className="zx-ticket__shape" aria-hidden>
                  <path d={TEAR_UPPER} transform={TEAR_STUB_TRANSFORM} />
                </svg>
                <span className="zx-ticket__stub-band">
                  <span className="zx-ticket__code">ORC-SDM1</span>
                  <span>Admit one</span>
                </span>
              </motion.span>
              <svg viewBox="2 8 59 49" className="zx-ticket__perf" aria-hidden>
                <path d="M4 22.55H42.45L20.45 42.55H60" vectorEffect="non-scaling-stroke" />
              </svg>
            </span>
          </motion.button>

          <motion.div
            ref={phone}
            className="zx-phone zx-door__phone"
            data-tone={verdict ?? undefined}
            style={{ x: shake }}
            role="group"
            aria-label="The scanner, as an usher's phone shows it"
          >
            <div className="zx-phone__screen zx-scanner">
              <div className="zx-scanner__bar">
                <span className="zx-scanner__show">
                  Gala evening <ChevronDown aria-hidden />
                </span>
                <AnimatePresence initial={false}>
                  {pill && (
                    <motion.span
                      key={pill.tone}
                      className="zx-scanner__pill"
                      data-tone={pill.tone}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.2 }}
                    >
                      {pill.tone === 'offline' ? <WifiOff aria-hidden /> : <RefreshCw aria-hidden className="zx-spin" />}
                      {pill.text}
                    </motion.span>
                  )}
                </AnimatePresence>
                <span className="zx-scanner__icons" aria-hidden>
                  {sound ? <Volume2 /> : <VolumeX />}
                  <CircleUserRound />
                </span>
              </div>

              <div ref={viewfinder} className="zx-scanner__view">
                <span className="zx-scanner__frame" aria-hidden />
                <AnimatePresence>
                  {screen === 'reading' && (
                    <motion.svg
                      key="qr"
                      className="zx-scanner__qr"
                      viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
                      initial={{ opacity: 0, scale: 0.7, rotate: -4 }}
                      animate={{ opacity: 1, scale: 1, rotate: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      aria-hidden
                    >
                      <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} rx="1.5" fill="#F6F3EE" />
                      <path d={qr.path} fill="#17151F" />
                    </motion.svg>
                  )}
                </AnimatePresence>
              </div>

              <div className="zx-scanner__tabs" aria-hidden>
                <span data-on="">
                  <ScanLine />
                  Scan
                </span>
                <span>
                  <Search />
                  Search
                </span>
                <span>
                  <ChartNoAxesColumn />
                  Stats
                </span>
              </div>

              <AnimatePresence>
                {verdict && (
                  <motion.div
                    key={screen}
                    className="zx-scanner__result"
                    data-tone={verdict}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                  >
                    {verdict === 'admitted' ? <CircleCheck aria-hidden /> : <TriangleAlert aria-hidden />}
                    <p className="zx-scanner__verdict">{verdict === 'admitted' ? 'Admitted' : 'Already checked in'}</p>
                    <p className="zx-scanner__name">Eleanor Whitfield</p>
                    <p className="zx-scanner__code">ORC-SDM1</p>
                    {screen === 'duplicate' && <p className="zx-scanner__detail">First scanned {firstScan} by Aisyah</p>}
                    {screen === 'admitted' && <p className="zx-scanner__party">Party of 3 · 1 in, 2 remaining</p>}
                    {screen === 'party' && <p className="zx-scanner__party">Party of 3 · 3 in</p>}
                    <div className="zx-scanner__actions">
                      {screen === 'admitted' && (
                        <button
                          type="button"
                          className="zx-scanner__button"
                          onClick={() => {
                            setScreen('party');
                            if (!online) setWaiting((n) => n + 2);
                          }}
                        >
                          Party of 3 · choose who&rsquo;s here
                        </button>
                      )}
                      <button type="button" className="zx-scanner__button zx-scanner__button--ghost" onClick={() => setScreen('ready')}>
                        Next
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>
      {children}
    </section>
  );
}

type Values = Record<string, MotionValue<number>>;

/** Animates a set of motion values to their targets together, resolving when every one arrives. */
function animateAll<T extends Values>(
  values: T,
  target: { [K in keyof T]: number },
  options: ValueAnimationTransition<number>,
) {
  return Promise.all((Object.keys(target) as Array<keyof T>).map((key) => animate(values[key], target[key], options)));
}
