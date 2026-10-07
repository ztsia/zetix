// usage: node qa/support/x-video.mjs <outdir> [clip ...]   — the demo video, one clip per flow
//
// Against `DEMO_SMTP_PORT=1025 pnpm demo`, freshly seeded, with Mailpit catching mail:
//   docker run -d --name zetix-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
// Run it in the published copy (`scripts/publish/publish.mjs` without `--push`), never here: the
// rename reaches text `brand.ts` does not, such as the sign-in heading and the page titles
// (spec/v3.md §31). Clips: console, themes, register, intake, reply, allocation, editor, send,
// guest, door — recorded in that order, because some leave the demo as a later one expects it.
// One guest, Eleanor, runs through the story: she registers, her tickets are sent, her email is
// opened, her ticket page is shown, and the door admits her. The edit reorders the clips.
//
// Desktop clips are 1920×1080 with a drawn cursor that glides; phone clips are a Pixel 7 driven by
// real touch input, with a circle where the finger lands — never a cursor on a phone. Each clip is
// recorded as WebM, trimmed to start once its first page has settled, and converted to an H.264
// MP4 by the system ffmpeg. DRY=1 takes a screenshot at each mark instead of recording.
import { chromium, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const [out, ...only] = process.argv.slice(2);
if (!out) throw new Error('usage: node qa/support/x-video.mjs <outdir> [clip ...]');
fs.mkdirSync(out, { recursive: true });

const BASE = 'http://localhost:3100';
const MAILPIT = 'http://localhost:8025';
const DRY = process.env.DRY === '1';
const ADMIN = { email: 'admin@example.org', password: process.env.DEMO_ADMIN_PASSWORD ?? 'demo-admin-pass' };
const USHER = { name: 'aisyah', code: process.env.DEMO_OPERATOR_CODE ?? 'demo-usher-code' };
const GUEST = {
  name: 'Eleanor Whitfield',
  email: 'eleanor.whitfield@example.com',
  phone: '+60 12-555 0199',
  guests: [{ name: 'Theo Whitfield' }, { name: 'Maren Okafor', email: 'maren.okafor@example.net' }],
};

const sql = postgres(process.env.DEMO_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_demo', {
  max: 1,
  onnotice: () => {},
});
const [concert] = await sql`select id from concerts order by id limit 1`;
const [rehearsal, gala] = await sql`select id from shows order by starts_at`;
const C = `/admin/concerts/${concert.id}`;
const [template] = await sql`
  select id from ticket_templates where concert_id = ${concert.id} or concert_id is null
   order by (concert_id is null), id desc limit 1`;
const [replied] = await sql`
  select t.registration_id from email_messages m join email_threads t on t.id = m.thread_id
   where m.direction = 'INBOUND' and not m.is_bounce order by m.message_at limit 1`;

/** Eleanor's own seat, once she has registered (the `register` clip); null before. */
const eleanor = async () => {
  const [row] = await sql`
    select a.qr_token, a.ticket_sent_at from attendees a join registrations r on r.id = a.registration_id
     where r.contact_email = ${GUEST.email} and a.full_name = ${GUEST.name} and a.deleted_at is null
     order by a.id desc limit 1`;
  return row ?? null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── What is drawn over the page ───────────────────────────────────────────────

/**
 * Mounted after `load`, so hydration never sees it. The cursor remembers where it was across
 * navigations (sessionStorage), and the touch circle is moved by the driver, not by DOM events,
 * so it is exactly where the input went. Next's dev badge is hidden: it is not part of the app.
 */
function overlay(kind) {
  const mount = () => {
    if (document.getElementById('__ov')) return;
    const style = document.createElement('style');
    style.id = '__ov';
    style.textContent = `
      nextjs-portal { display: none !important; }
      #__cur { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647;
        pointer-events: none; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      .__rip { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
        border: 2px solid rgba(255,106,77,.95); background: rgba(255,106,77,.18); z-index: 2147483646;
        pointer-events: none; animation: __rip .55s ease-out forwards; }
      @keyframes __rip { from { transform: scale(.35); opacity: 1 } to { transform: scale(1.35); opacity: 0 } }
      #__touch { position: fixed; left: 0; top: 0; width: 52px; height: 52px; margin: -26px 0 0 -26px;
        border-radius: 50%; background: rgba(255,255,255,.42); border: 2px solid rgba(40,40,40,.32);
        box-shadow: 0 0 0 1px rgba(255,255,255,.5), 0 2px 8px rgba(0,0,0,.18); z-index: 2147483647;
        pointer-events: none; opacity: 0; transform: scale(.6);
        transition: opacity .16s ease, transform .16s ease; }
      #__touch.on { opacity: 1; transform: scale(1); }
      .__trail { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
        background: rgba(120,120,120,.28); z-index: 2147483646; pointer-events: none;
        animation: __fade .45s ease-out forwards; }
      @keyframes __fade { to { opacity: 0; transform: scale(.4) } }`;
    document.head.append(style);

    if (kind === 'cursor') {
      const cur = document.createElement('div');
      cur.id = '__cur';
      cur.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M5 3 L5 21 L9.6 16.6 L12.8 23.4 L15.8 22.1 L12.6 15.4 L19 15.4 Z" fill="#17151F" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.body.append(cur);
      const place = (x, y) => {
        cur.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
        try { sessionStorage.setItem('__cur', JSON.stringify({ x, y })); } catch {}
      };
      let start = { x: innerWidth / 2, y: innerHeight / 2 };
      try { start = JSON.parse(sessionStorage.getItem('__cur')) ?? start; } catch {}
      place(start.x, start.y);
      addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
      addEventListener('mousedown', (e) => {
        const r = document.createElement('div');
        r.className = '__rip';
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.body.append(r);
        setTimeout(() => r.remove(), 600);
      }, true);
    } else {
      const dot = document.createElement('div');
      dot.id = '__touch';
      document.body.append(dot);
      window.__touch = {
        down(x, y) { dot.style.left = `${x}px`; dot.style.top = `${y}px`; dot.classList.add('on'); },
        move(x, y) {
          dot.style.left = `${x}px`; dot.style.top = `${y}px`;
          const t = document.createElement('div');
          t.className = '__trail'; t.style.left = `${x}px`; t.style.top = `${y}px`;
          document.body.append(t); setTimeout(() => t.remove(), 500);
        },
        up() { dot.classList.remove('on'); },
      };
    }
  };
  if (document.readyState === 'complete') mount();
  else addEventListener('load', mount);
}

// ── Driving a desktop page with a visible cursor ──────────────────────────────

function desktop(page) {
  let at = { x: 960, y: 540 };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const self = {
    page,
    async to(x, y) {
      const dist = Math.hypot(x - at.x, y - at.y);
      const ms = Math.min(950, Math.max(280, dist * 0.75));
      const steps = Math.max(8, Math.round(ms / 16));
      const from = at;
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
        await sleep(ms / steps);
      }
      at = { x, y };
    },
    async point(locator, { dx = 0, dy = 0 } = {}) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error(`nothing to point at: ${locator}`);
      await self.to(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    },
    async click(locator, options) {
      await self.point(locator, options);
      await sleep(160);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
      await sleep(450);
    },
    async type(locator, text) {
      await self.click(locator);
      await page.keyboard.type(text, { delay: 55 });
      await sleep(250);
    },
    async scroll(dy, ms = 900) {
      const steps = Math.round(ms / 16);
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(16);
      }
      await sleep(250);
    },
    /** Scroll smoothly until the element sits near the top of the window. */
    async reveal(locator, ms = 1100) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`nothing to reveal: ${locator}`);
      const dy = box.y - 180;
      if (Math.abs(dy) > 24) await self.scroll(dy, ms);
    },
    hold: (ms) => sleep(ms),
  };
  return self;
}

// ── Driving a phone with touch, and drawing where the finger lands ────────────

async function phone(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const draw = (fn, x, y) => page.evaluate(([f, a, b]) => window.__touch?.[f](a, b), [fn, x, y]).catch(() => {});
  const view = PHONE.css;
  const self = {
    page,
    async tap(locator, { dx = 0, dy = 0 } = {}) {
      await self.reveal(locator);
      const box = await locator.boundingBox();
      if (!box) throw new Error(`nothing to tap: ${locator}`);
      const x = box.x + box.width / 2 + dx;
      const y = box.y + box.height / 2 + dy;
      await draw('down', x, y);
      await sleep(140);
      await touch('touchStart', [{ x, y }]);
      await sleep(70);
      await touch('touchEnd', []);
      await sleep(120);
      await draw('up');
      await sleep(450);
    },
    /** A finger dragging from one point to another; the page scrolls itself. */
    async swipe(fromY, toY, { x = view.width / 2, ms = 520 } = {}) {
      const steps = Math.max(10, Math.round(ms / 16));
      await draw('down', x, fromY);
      await sleep(110);
      await touch('touchStart', [{ x, y: fromY }]);
      for (let i = 1; i <= steps; i++) {
        const y = fromY + ((toY - fromY) * i) / steps;
        await touch('touchMove', [{ x, y }]);
        await draw('move', x, y);
        await sleep(ms / steps);
      }
      await sleep(60);
      await touch('touchEnd', []);
      await draw('up');
      await sleep(650);
    },
    /** Scroll the page by about `px` CSS pixels, with one swipe (negative scrolls back). */
    async scroll(px, ms = 520) {
      const from = px > 0 ? view.height * 0.75 : view.height * 0.25;
      await self.swipe(from, from - px, { ms });
    },
    /** Scroll up, by swiping, until the element is comfortably on screen. */
    async reveal(locator) {
      for (let i = 0; i < 12; i++) {
        const box = await locator.boundingBox();
        if (!box) return;
        const bottom = box.y + box.height;
        if (box.y >= 70 && bottom <= view.height - 110) return;
        const need = bottom > view.height - 110 ? bottom - (view.height - 160) : box.y - 120;
        const step = Math.max(-420, Math.min(420, need));
        await self.swipe(view.height * 0.62, view.height * 0.62 - step, { ms: 420 });
      }
    },
    async type(locator, text) {
      await self.tap(locator);
      await page.keyboard.type(text, { delay: 70 });
      await sleep(250);
    },
    hold: (ms) => sleep(ms),
  };
  return self;
}

// ── Recording ─────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
let adminState = null;

async function signedInState() {
  if (adminState) return adminState;
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 120_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  adminState = await ctx.storageState();
  await ctx.close();
  return adminState;
}

/**
 * The phone, rendered at its real density rather than emulated. Under Playwright's device
 * emulation Chromium's screencast — what `recordVideo` records — delivers frames at CSS size, 412
 * px wide on a Pixel 7, a third of its pixels. A browser launched at the Pixel 7's scale factor,
 * with a window its CSS size and no viewport emulation, renders and screencasts at 1082 × 2402.
 * Touch is on, and the user agent is the Pixel's, so the pages behave as on the phone.
 */
const PHONE = {
  css: { width: 412, height: 915 },
  scale: 2.625,
  get video() {
    return { width: Math.round(this.css.width * this.scale / 2) * 2, height: Math.round(this.css.height * this.scale / 2) * 2 };
  },
  args() {
    return [`--force-device-scale-factor=${this.scale}`, `--window-size=${this.css.width},${this.css.height}`];
  },
};

/**
 * One clip: a fresh context, recorded; `body` drives it. `marks` timestamps where the clip
 * begins (the first page settled), so the blank start can be cut.
 */
async function clip(n, name, { device, admin = false, launch = null }, body) {
  if (only.length && !only.includes(name)) return;
  const isPhone = device === 'phone';
  const size = isPhone ? PHONE.video : { width: 1920, height: 1080 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zetix-video-'));
  const own = isPhone || launch;
  const owner = own ? await chromium.launch({ args: [...(launch?.args ?? []), ...(isPhone ? PHONE.args() : [])] }) : browser;
  const ctx = await owner.newContext({
    ...(isPhone
      ? { viewport: null, hasTouch: true, userAgent: devices['Pixel 7'].userAgent }
      : { viewport: size, deviceScaleFactor: 1 }),
    baseURL: BASE,
    colorScheme: 'light',
    ...(admin ? { storageState: await signedInState() } : {}),
    ...(DRY ? {} : { recordVideo: { dir: tmp, size } }),
  });
  await ctx.addInitScript(overlay, isPhone ? 'touch' : 'cursor');
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('zetix.console.theme', 'default');
      localStorage.setItem('zetix.console.mode', 'light');
    } catch {}
  });
  const opened = Date.now();
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`[${r.status()}] ${r.url()}`); });

  let begin = null;
  let shots = 0;
  const mark = async (label) => {
    if (begin === null) begin = Date.now();
    if (DRY) await page.screenshot({ path: path.join(out, `${n}-${name}-${String(++shots).padStart(2, '0')}-${label}.png`) });
  };
  const driver = isPhone ? await phone(page) : desktop(page);
  try {
    await body({ page, d: driver, mark });
    await sleep(1200);
  } catch (error) {
    await page.screenshot({ path: path.join(out, `${n}-${name}-FAILED.png`) }).catch(() => {});
    throw error;
  } finally {
    const video = page.video();
    await ctx.close();
    if (own) await owner.close();
    if (video) {
      const webm = await video.path();
      const mp4 = path.join(out, `${n}-${name}.mp4`);
      const skip = Math.max(0, ((begin ?? opened) - opened) / 1000 - 0.3);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip.toFixed(2), '-i', webm,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`${n}-${name}.mp4`);
    }
    console.log(`${name}: ${problems.length ? problems.join(' | ') : 'no errors'}`);
  }
}

const settle = async (page, ms = 900) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(ms);
};
const hideBanner = async (page) => {
  const hide = page.getByRole('button', { name: 'Hide this banner' });
  if (await hide.count()) await hide.first().click();
};

// ── The clips ─────────────────────────────────────────────────────────────────

await clip('01', 'console', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/home`);
  await settle(page);
  await hideBanner(page);
  await mark('home');
  await d.hold(1200);
  for (const card of ['Needs review', 'Replies waiting', 'Possible duplicates', 'Unnamed guests']) {
    await d.point(page.getByText(card, { exact: true }).first());
    await d.hold(380);
  }
  await d.scroll(520, 1100);
  await mark('pipeline');
  await d.hold(1600);
  await d.scroll(-520, 900);
  await d.click(page.getByText('Needs review', { exact: true }).first());
  await page.waitForURL((u) => u.pathname.endsWith('/audience'), { timeout: 60_000 });
  await settle(page);
  await hideBanner(page);
  await mark('queue');
  await d.hold(1400);
  await d.click(page.locator('table tbody tr').first().getByRole('link').first());
  await page.waitForURL((u) => /\/audience\/\d+$/.test(u.pathname), { timeout: 60_000 });
  await settle(page);
  await hideBanner(page);
  await mark('party');
  await d.hold(1600);
  await d.point(page.getByRole('button', { name: 'Grant extras' }));
  await d.hold(900);
  await d.point(page.getByText('Waiting for review').first());
  await d.hold(1400);
});

await clip('02', 'themes', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/home`);
  await settle(page);
  await hideBanner(page);
  await mark('home');
  await d.hold(900);
  await d.click(page.getByRole('button', { name: /^Appearance/ }).first());
  await d.hold(700);
  // The menu stays open while a choice applies, so every change happens live behind it.
  const menu = page.getByRole('menu');
  for (const label of ['Terracotta', 'Amethyst', 'Dark', 'Emerald', 'Mono', 'Default', 'Light']) {
    await d.click(menu.getByRole('menuitemradio', { name: label }));
    await mark(label.toLowerCase());
    await d.hold(label === 'Dark' ? 1300 : 1000);
  }
  await page.keyboard.press('Escape');
  await d.hold(800);
});

await clip('03', 'register', { device: 'phone' }, async ({ page, d, mark }) => {
  await page.goto('/f/autumn-gala');
  await settle(page);
  await mark('form');
  await d.hold(1300);
  const field = (id) => page.locator(`[id="${id}"]`);
  await d.type(field('registrant.contact_name'), GUEST.name);
  await d.type(field('registrant.contact_email'), GUEST.email);
  await d.type(field('registrant.contact_phone'), GUEST.phone);
  await mark('details');
  await d.type(field('party.0.full_name'), GUEST.guests[0].name);
  await d.tap(page.getByRole('button', { name: /Add a guest/ }));
  await d.type(field('party.1.full_name'), GUEST.guests[1].name);
  await d.type(field('party.1.email'), GUEST.guests[1].email);
  await mark('guests');
  await d.hold(700);
  await d.tap(page.getByRole('button', { name: 'Submit' }));
  await page.getByText('Your registration has been recorded').waitFor({ timeout: 60_000 });
  await settle(page, 600);
  await mark('done');
  await d.hold(2600);
  // A public form asks the registrant to confirm her address; she taps the link in that email.
  const [her] = await sql`select verification_token from registrations where contact_email = ${GUEST.email} order by id desc limit 1`;
  await page.goto(`/f/verify?t=${encodeURIComponent(her.verification_token)}`);
  await settle(page, 600);
  await mark('verified');
  await d.hold(2200);
});

await clip('04', 'intake', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/forms`);
  await settle(page);
  await hideBanner(page);
  await mark('forms');
  await d.hold(1200);
  const gala = page.getByText('Autumn Serenade — gala evening', { exact: true });
  await d.point(gala);
  await d.hold(900);
  await d.click(gala);
  await settle(page);
  await hideBanner(page);
  await mark('builder');
  await d.hold(1200);
  await d.scroll(700, 1300);
  await d.hold(900);
  await d.scroll(-700, 900);
  await d.click(page.getByRole('tab', { name: /Responses/ }).or(page.getByRole('link', { name: /Responses/ })).first());
  await page.waitForURL((u) => u.pathname.endsWith('/responses'), { timeout: 60_000 });
  await settle(page);
  await mark('responses');
  await d.hold(1800);
  await d.click(page.getByRole('link', { name: 'Audience' }).first());
  await settle(page);
  await hideBanner(page);
  await d.type(page.getByPlaceholder(/Search name/), 'Whitfield');
  await settle(page, 700);
  await mark('found');
  await d.hold(1000);
  await d.click(page.getByRole('link', { name: GUEST.name }).first());
  await settle(page);
  await hideBanner(page);
  await mark('record');
  await d.hold(1800);
  await d.scroll(400, 900);
  await d.hold(1400);
});

await clip('05', 'reply', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/audience/${replied.registration_id}`);
  await settle(page);
  await hideBanner(page);
  await mark('party');
  await d.hold(1200);
  // The guest's answer to her tickets email, threaded under it on her record.
  const reply = page.getByText(/^Re: Your tickets/).first();
  await d.reveal(reply);
  await d.point(reply);
  await mark('conversation');
  await d.hold(1800);
  await d.click(page.getByRole('button', { name: 'Reply', exact: true }).first());
  await settle(page, 600);
  await d.type(page.getByPlaceholder(/Write your reply/), 'Nothing to do — enjoy the evening, and thank you for letting us know.');
  await mark('compose');
  await d.hold(1800);
});

await clip('06', 'allocation', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/shows`);
  await settle(page);
  await hideBanner(page);
  await mark('shows');
  await d.hold(1400);
  // The gala's hall, then how its public segment's seats stand: confirmed, and the extras pool.
  await d.point(page.getByText(/^Hall 320$|^Hall \d+$/).last());
  await mark('hall');
  await d.hold(1400);
  await d.point(page.getByText(/^\d+ in the extras pool$/).last());
  await mark('pool');
  await d.hold(2000);
});

await clip('07', 'editor', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/tickets/templates/${template.id}`);
  await settle(page, 1500);
  await hideBanner(page);
  await mark('editor');
  await d.hold(1200);
  // Konva draws the ticket on a canvas, so its elements are clicked by where they sit on it.
  const canvas = page.locator('canvas').last();
  const box = await canvas.boundingBox();
  const at = (fx, fy) => d.to(box.x + box.width * fx, box.y + box.height * fy);
  const press = async () => { await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(500); };
  await at(0.18, 0.36);
  await press();
  await mark('name');
  await d.hold(1500);
  await at(0.93, 0.37);
  await press();
  await mark('qr');
  await d.hold(1600);
});

await clip('08', 'send', { device: 'desktop', admin: true }, async ({ page, d, mark }) => {
  await page.goto(`${C}/audience`);
  await settle(page);
  await hideBanner(page);
  await mark('audience');
  await d.hold(1000);
  // Eleanor's party is confirmed but not yet issued: the wizard issues and sends in one run.
  await d.click(page.getByRole('button', { name: /^Needs tickets/ }).or(page.getByRole('link', { name: /^Needs tickets/ })).first());
  await settle(page, 700);
  await d.click(page.getByRole('checkbox', { name: /select all/i }).first());
  await d.hold(500);
  await d.click(page.getByRole('button', { name: /^Send tickets/ }));
  await settle(page, 900);
  await mark('who');
  await d.hold(1800);
  for (const step of ['design', 'email', 'send']) {
    await d.click(page.getByRole('dialog').getByRole('button', { name: /^Next/ }));
    await settle(page, 600);
    // The design and email steps render previews server side; wait until they are drawn.
    if (step === 'design') await page.getByRole('dialog').locator('img').first().waitFor({ timeout: 60_000 });
    if (step === 'email') await page.getByRole('dialog').locator('iframe').first().waitFor({ timeout: 60_000 }).catch(() => {});
    await sleep(900);
    await mark(step);
    await d.hold(step === 'send' ? 1600 : 2200);
  }
  await d.click(page.getByRole('dialog').getByRole('button', { name: /^Send/ }).last());
  await page.getByText('Completed', { exact: true }).waitFor({ timeout: 120_000 });
  await settle(page, 600);
  await mark('report');
  await d.hold(2200);
  await d.click(page.getByRole('dialog').getByRole('button', { name: 'Close' }).first());
  await d.hold(800);
  // Dispatch sends one message at a time, PDFs attached, and Eleanor's is queued last: open the
  // mailbox once hers has landed, so it is at the top of the list.
  let message = null;
  for (let tries = 0; tries < 90 && !message; tries++) {
    const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${GUEST.email}"`)}`).then((r) => r.json());
    message = found.messages?.[0] ?? null;
    if (!message) await sleep(2000);
  }
  if (!message) throw new Error(`no email to ${GUEST.email} in Mailpit — was her party in "Needs tickets"?`);
  await page.goto(MAILPIT);
  await settle(page, 1200);
  await mark('mailpit');
  await d.hold(1200);
  const row = page.locator(`a[href$="${message.ID}"]`).first();
  if (await row.count()) await d.click(row);
  else await page.goto(`${MAILPIT}/view/${message.ID}`);
  await settle(page, 1500);
  await mark('email');
  await d.hold(1800);
  await d.scroll(600, 1300);
  await d.hold(1800);
});

// Eleanor's ticket, once `send` has sent it; a fresh seed's gala guest when the clips run alone.
const herTicket = async () => {
  const her = await eleanor();
  if (her?.ticket_sent_at) return her.qr_token;
  if (her && (!only.length || only.includes('send'))) throw new Error(`${GUEST.name} registered but her tickets were not sent`);
  const [row] = await sql`
    select a.qr_token from attendees a
     where a.show_id = ${gala.id} and a.ticket_sent_at is not null and a.qr_token is not null
       and a.name_source = 'PROVIDED' and a.deleted_at is null
       and not exists (select 1 from check_ins c where c.attendee_id = a.id)
     order by a.id limit 1`;
  return row.qr_token;
};

const ticket = await herTicket();
const [after] = await sql`
  select a.qr_token from attendees a join check_ins c on c.attendee_id = a.id
   where a.show_id = ${rehearsal.id} and a.qr_token is not null
     and not exists (select 1 from feedback_responses r where r.attendee_id = a.id)
   order by a.id limit 1`;

await clip('09', 'guest', { device: 'phone' }, async ({ page, d, mark }) => {
  await page.goto(`/t/${ticket}`);
  await settle(page, 1200);
  await mark('ticket');
  await d.hold(1800);
  await d.scroll(420);
  await d.hold(1000);
  await d.scroll(420);
  await mark('info');
  await d.hold(1600);
  await page.goto(`/t/${after.qr_token}`);
  await settle(page, 1200);
  await mark('after');
  await d.hold(1400);
  await d.tap(page.getByRole('radio', { name: /^5/ }).or(page.getByLabel(/5 stars?/)).first());
  await d.hold(500);
  await d.tap(page.getByText('Overture — An Autumn Morning'));
  await d.hold(500);
  const comment = page.getByRole('textbox').first();
  await d.type(comment, 'Lovely afternoon — the strings were wonderful.');
  await mark('feedback');
  await d.tap(page.getByRole('button', { name: /^Submit|^Send/ }).first());
  await settle(page, 1200);
  await mark('thanks');
  await d.hold(1600);
  await d.type(page.getByPlaceholder('What stayed with you?'), 'Bravo to the second violins — the Serenade was beautiful.');
  await mark('note');
  await d.tap(page.getByRole('button', { name: 'Send my note' }));
  await settle(page, 1000);
  await mark('noted');
  await d.hold(2400);
});

const y4m = path.join(os.tmpdir(), 'zetix-door-qr.y4m');
execFileSync(process.execPath, ['qa/support/qa-qr-y4m.mjs', `${BASE}/t/${ticket}`, y4m]);

await clip('10', 'door', {
  device: 'phone',
  launch: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] },
}, async ({ page, d, mark }) => {
  await page.context().grantPermissions(['camera'], { origin: BASE });
  await page.goto('/scan/login');
  await settle(page);
  await mark('login');
  await d.hold(900);
  await d.type(page.locator('input[name="displayName"]'), USHER.name);
  await d.type(page.locator('input[name="code"]'), USHER.code);
  await d.tap(page.locator('button[type="submit"]'));
  await page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 60_000 });
  await settle(page, 1200);
  if (!page.url().includes(`/scan/${gala.id}`)) {
    await page.goto(`/scan/${gala.id}`);
    await settle(page, 1200);
  }
  await mark('ready');
  await d.hold(1000);
  // The roster is on the phone; the signal goes, and the door carries on (spec/checkin.md §12).
  await page.context().setOffline(true);
  await page.getByText('Offline', { exact: true }).waitFor({ timeout: 15_000 });
  await mark('offline');
  await d.hold(1400);
  await d.tap(page.getByRole('button', { name: 'Start scanning' }));
  await page.getByText('Admitted', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText(/^Offline · 1 waiting$/).waitFor({ timeout: 15_000 });
  await mark('admitted');
  await d.hold(2600);
  // The camera still sees the same ticket: the second read is refused as a duplicate.
  await d.tap(page.getByRole('button', { name: 'Next' }));
  await page.getByText('Already checked in').waitFor({ timeout: 30_000 });
  await mark('duplicate');
  await d.hold(2200);
  // The signal comes back, and the waiting admission syncs.
  await page.context().setOffline(false);
  await page.getByText(/^Offline/).waitFor({ state: 'detached', timeout: 30_000 });
  await page.getByText(/waiting$|^Syncing/).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
  await mark('synced');
  await d.hold(1800);
  await d.tap(page.getByRole('tab', { name: /Search/ }).or(page.getByRole('button', { name: /^Search/ })).first());
  const search = page.locator('input[type="search"]').first();
  await d.type(search, 'Ingleby');
  await settle(page, 700);
  await mark('search');
  await d.hold(1800);
  await page.getByRole('button', { name: /clear/i }).first().click().catch(() => search.fill(''));
  await d.type(search, 'Hargreaves');
  await settle(page, 600);
  await mark('no-match');
  await d.hold(1400);
  await d.tap(page.getByRole('button', { name: /Record as walk-in/ }));
  await settle(page, 600);
  await d.tap(page.getByRole('button', { name: 'One more' }));
  await mark('walk-in');
  await d.hold(1000);
  await d.tap(page.getByRole('button', { name: /^Admit \d+ walk-in/ }));
  await settle(page, 900);
  await d.tap(page.getByRole('tab', { name: /Stats/ }).or(page.getByRole('button', { name: /^Stats/ })).first());
  await settle(page, 900);
  await mark('stats');
  await d.hold(2400);
});

await browser.close();
await sql.end();
