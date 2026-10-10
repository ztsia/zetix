'use client';

import { useEffect, useRef, useState } from 'react';
import Image, { type StaticImageData } from 'next/image';
import { Maximize2 } from 'lucide-react';
import {
  AnimatePresence,
  easeIn,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { LivePhone } from './live-phone';
import { Modal } from './modal';
import { Plate } from './plate';
import partyShot from '../../../../docs/screenshots/party.png';
import homeShot from '../../../../docs/screenshots/home.png';
import ticketShot from '../../../../docs/screenshots/ticket-light.png';

type Shot = {
  kind: 'window' | 'phone';
  image: StaticImageData;
  alt: string;
  /** Where the camera pushes in to, and how far, as the movement is read. */
  focus: string;
  zoom: number;
  /** A phone runs the guest's real page, from this path, instead of showing its picture. */
  live?: string;
};

type Movement = {
  numeral: string;
  title: string;
  tempo: string;
  body: string;
  plate: React.ReactNode;
  shot: Shot;
};

/** Movements I to III. IV, the door, is its own section: it is where the lights go down. */
const MOVEMENTS: Movement[] = [
  {
    numeral: 'I',
    title: 'Registration',
    tempo: 'Allegro',
    body: 'Guests sign up on a form built in the console, or arrive from a spreadsheet. One email covers the party, and each guest gets a ticket.',
    plate: (
      <>
        Guests register as a party: one email, <em>a ticket each.</em>
      </>
    ),
    shot: {
      kind: 'window',
      image: partyShot,
      alt: "A party's record in the console: three guests, their seats, tickets and delivery",
      focus: '62% 50%',
      zoom: 1.34,
    },
  },
  {
    numeral: 'II',
    title: 'The console',
    tempo: 'Vivace',
    body: 'Every party is one record whose stage is derived, never stored. Work queues gather what needs a hand: reviews, replies, bounces and duplicates.',
    plate: (
      <>
        What needs attention, <em>on one screen.</em>
      </>
    ),
    shot: {
      kind: 'window',
      image: homeShot,
      alt: "The console's Home: what needs attention, and where every party is",
      focus: '58% 30%',
      zoom: 1.32,
    },
  },
  {
    numeral: 'III',
    title: 'Seats and tickets',
    tempo: 'Moderato',
    body: 'A canvas editor designs the ticket. Its design is pinned when issued, so a later edit never changes a ticket someone already holds.',
    plate: (
      <>
        Every ticket has <em>its own page.</em>
      </>
    ),
    shot: {
      kind: 'phone',
      image: ticketShot,
      alt: "A guest's ticket page: the show, the hall and her QR code",
      focus: '50% 50%',
      // A phone is not pushed in on: it is a page to scroll, not a picture to read.
      zoom: 1,
      live: '/showcase/phone/ticket',
    },
  },
];

/**
 * How each movement spends its share of the scroll, as fractions of that share. The tear straddles
 * the boundary between two movements, `TEAR` either side of it; the push-in follows the tear and
 * ends at `PUSH`; from there to the next tear the shot holds still, so it can be read.
 */
const TEAR = 0.16;
const PUSH = 0.42;

/**
 * The programme: the movements on the left, a stage on the right that holds still while they pass.
 * As each one is read the camera pushes in, as the film does, then holds; when the next arrives the
 * shot shears along the mark's Z and falls away, which is the film's chapter change. Everything on
 * the stage is driven by the scroll position, not set off by it, so stopping halfway through a tear
 * leaves it half torn, and scrolling back mends it. On a phone there is no stage: each movement
 * carries its own picture.
 */
export function Programme() {
  const list = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState(0);
  // The enlarged screenshot, kept while the dialog leaves so its picture leaves with it.
  const [enlarged, setEnlarged] = useState<Shot | null>(null);
  const [open, setOpen] = useState(false);
  const enlarge = (shot: Shot) => {
    setEnlarged(shot);
    setOpen(true);
  };
  const { scrollYProgress } = useScroll({ target: list, offset: ['start center', 'end center'] });
  const count = MOVEMENTS.length;

  // The movement whose share the middle of the viewport is in: its text is lit, its plate is shown.
  useMotionValueEvent(scrollYProgress, 'change', (progress) => {
    setActive(Math.min(count - 1, Math.max(0, Math.floor(progress * count))));
  });

  return (
    <section id="programme" className="zx-programme" data-cue="up" aria-labelledby="zx-programme-title">
      <div className="zx-wrap">
        <header className="zx-section-head">
          <h2 id="zx-programme-title" className="zx-h2">
            The programme
          </h2>
          <p className="zx-section-head__lead">
            Four movements, from the first form to the last guest through the door. The screens are from
            the demo&rsquo;s fictional concert, <i>Autumn Serenade</i>.
          </p>
        </header>

        <div className="zx-programme__grid">
          <ol ref={list} className="zx-programme__movements">
            {MOVEMENTS.map((movement, index) => (
              <li
                key={movement.numeral}
                data-movement={index}
                className="zx-movement"
                data-active={active === index ? '' : undefined}
              >
                <span className="zx-movement__numeral" aria-hidden>
                  {movement.numeral}.
                </span>
                <div className="zx-movement__text">
                  <h3 className="zx-movement__title">
                    <span className="sr-only">Movement {movement.numeral}: </span>
                    {movement.title}
                  </h3>
                  <i className="zx-movement__tempo">{movement.tempo}</i>
                  <p className="zx-movement__body">{movement.body}</p>
                </div>
                <div className="zx-movement__inline">
                  <ShotFrame
                    shot={movement.shot}
                    sizes="(min-width: 768px) 70vw, 92vw"
                    onEnlarge={enlarge}
                  />
                  <Plate className="zx-movement__plate">{movement.plate}</Plate>
                </div>
              </li>
            ))}
          </ol>

          <div className="zx-programme__stage-col">
            <div className="zx-stage">
              <div className="zx-stage__box">
                {MOVEMENTS.map((movement, index) => (
                  <StageShot
                    key={movement.numeral}
                    shot={movement.shot}
                    index={index}
                    count={count}
                    progress={scrollYProgress}
                    onEnlarge={enlarge}
                  />
                ))}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={active}
                    className="zx-stage__plate"
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Plate>{MOVEMENTS[active].plate}</Plate>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} label={enlarged?.alt ?? 'Screenshot'} panelClassName="zx-enlarge">
        {enlarged ? (
          <Image src={enlarged.image} alt={enlarged.alt} sizes="(min-width: 1400px) 1360px, 100vw" className="zx-enlarge__img" />
        ) : null}
      </Modal>
    </section>
  );
}

/** The two halves of a shot, cut along the mark's Z (spec: `video-edit/src/brand.ts`). */
const UPPER = 'polygon(-20% -20%, 120% -20%, 120% 71.7%, 30.4% 71.7%, 69.6% 28.3%, -20% 28.3%)';
const LOWER = 'polygon(-20% 28.3%, 69.6% 28.3%, 30.4% 71.7%, 120% 71.7%, 120% 120%, -20% 120%)';

function StageShot({
  shot,
  index,
  count,
  progress,
  onEnlarge,
}: {
  shot: Shot;
  index: number;
  count: number;
  progress: MotionValue<number>;
  onEnlarge: (shot: Shot) => void;
}) {
  // Read inside the transforms rather than baked into them, so the first render is the same on
  // the server and the client (where the preference is known), and a change applies on next scroll.
  const reduce = useReducedMotion();
  const still = useRef(false);
  useEffect(() => {
    still.current = Boolean(reduce);
  }, [reduce]);

  const share = 1 / count;
  const half = TEAR * share;
  const start = index * share;
  const end = start + share;
  const last = index === count - 1;

  // 0 until this shot starts to tear, 1 once it has gone; the last one never tears.
  const tear = useTransform(progress, last ? [2, 3] : [end - half, end + half], [0, 1]);
  // The perforation is punched first, then the halves part and fall.
  const part = useTransform(tear, [0.12, 1], [0, 1], { ease: easeIn });
  const fade = useTransform(tear, [0.45, 1], [1, 0]);
  const zoom = useTransform(progress, [index === 0 ? 0 : start + half, start + PUSH * share], [1, shot.zoom]);
  // Revealed by the tear above it, it settles forward into place.
  const rise = useTransform(progress, index === 0 ? [-2, -1] : [start - half, start + half], [0.965, 1]);

  // A function transform subscribes to the values it reads on its first run, so each one reads its
  // values before choosing between them.
  const scale = useTransform(() => {
    const value = zoom.get();
    return still.current ? 1 : value;
  });
  const shotScale = useTransform(() => {
    const value = rise.get();
    return still.current ? 1 : value;
  });
  const shotOpacity = useTransform(() => {
    const value = tear.get();
    return still.current ? 1 - value : 1;
  });
  const halfOpacity = useTransform(() => {
    const value = fade.get();
    return still.current ? 1 : value;
  });
  const upperX = useTransform(() => {
    const value = -4 * part.get();
    return `${still.current ? 0 : value}%`;
  });
  const upperY = useTransform(() => {
    const value = -7 * part.get();
    return `${still.current ? 0 : value}%`;
  });
  const upperRotate = useTransform(() => {
    const value = -2 * part.get();
    return still.current ? 0 : value;
  });
  const lowerX = useTransform(() => {
    const value = 5 * part.get();
    return `${still.current ? 0 : value}%`;
  });
  const lowerY = useTransform(() => {
    const value = 9 * part.get();
    return `${still.current ? 0 : value}%`;
  });
  const lowerRotate = useTransform(() => {
    const value = 2.5 * part.get();
    return still.current ? 0 : value;
  });
  // The lower copy is cut along the Z only while it tears, so a shot at rest has no seam in it.
  const lowerClip = useTransform(() => {
    const value = tear.get();
    return !still.current && value > 0 ? LOWER : 'none';
  });
  const cut = useTransform(() => {
    const value = punch(tear.get());
    return still.current ? 0 : value;
  });
  // On stage only from the moment the shot above starts tearing to reveal it until it has gone, so
  // a later shot of another shape (the phone) never shows round the edges of an earlier one.
  const visibility = useTransform(() => {
    const [gone, at] = [tear.get() >= 1, progress.get()];
    return gone || (index > 0 && at < start - half) ? 'hidden' : 'visible';
  });

  return (
    <motion.div
      className="zx-stage__shot"
      style={{ zIndex: count - index, scale: shotScale, opacity: shotOpacity, visibility }}
    >
      <motion.div
        data-half="lower"
        className="zx-stage__half"
        style={{ x: lowerX, y: lowerY, rotate: lowerRotate, opacity: halfOpacity, clipPath: lowerClip }}
      >
        <ShotFrame shot={shot} scale={scale} sizes="(min-width: 1024px) 56vw, 1px" onEnlarge={onEnlarge} />
      </motion.div>
      {/* The last shot never tears, so it needs no second half; and a live page must exist once. */}
      {last ? null : (
        <motion.div
          data-half="upper"
          className="zx-stage__half"
          style={{ x: upperX, y: upperY, rotate: upperRotate, opacity: halfOpacity, clipPath: UPPER }}
          aria-hidden
        >
          <ShotFrame shot={shot} scale={scale} sizes="(min-width: 1024px) 56vw, 1px" decorative />
        </motion.div>
      )}
      <motion.svg
        className="zx-stage__cut"
        style={{ opacity: cut }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        <path d="M0 28.3H69.6L30.4 71.7H100" vectorEffect="non-scaling-stroke" />
      </motion.svg>
    </motion.div>
  );
}

/** The perforation's opacity through a tear: punched in quickly, held, gone as the halves fall. */
const punch = (tear: number) =>
  tear <= 0 ? 0 : tear < 0.1 ? tear / 0.1 : tear < 0.5 ? 1 : Math.max(0, 1 - (tear - 0.5) / 0.4);

function ShotFrame({
  shot,
  scale,
  sizes,
  decorative = false,
  onEnlarge,
}: {
  shot: Shot;
  scale?: MotionValue<number>;
  sizes: string;
  /**
   * The stage draws each shot twice, one half over the other; only one of them is described, and
   * only the other one takes clicks, so the copy on top lets them through (`showcase.css`).
   */
  decorative?: boolean;
  /** A window opens full size when clicked: the console is too dense to read at this scale. */
  onEnlarge?: (shot: Shot) => void;
}) {
  const picture = (
    <motion.div className="zx-shot__zoom" style={{ scale, transformOrigin: shot.focus }}>
      <Image src={shot.image} alt={decorative ? '' : shot.alt} sizes={sizes} className="zx-shot__img" placeholder="blur" />
    </motion.div>
  );
  if (shot.kind === 'window') {
    return onEnlarge && !decorative ? (
      <button type="button" className="zx-window zx-window--open" onClick={() => onEnlarge(shot)} aria-label={`Enlarge: ${shot.alt}`}>
        {picture}
        <span className="zx-window__enlarge" aria-hidden>
          <Maximize2 />
        </span>
      </button>
    ) : (
      <div className="zx-window">{picture}</div>
    );
  }
  if (shot.live && !decorative) {
    return <LivePhone label={shot.alt} src={shot.live} still={shot.image} stillAlt={shot.alt} sizes={sizes} />;
  }
  return (
    <div className="zx-phone zx-phone--shot">
      <div className="zx-phone__screen">{picture}</div>
    </div>
  );
}
