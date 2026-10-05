// Regenerates public/brand/: the Zetix "Tear" mark as two plain paths (no masks, so it inlines anywhere),
// One source for the favicon, the app and touch icons, and the README lockups.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Run with `node scripts/brand-assets.mjs`; the lockups load Sora from Google Fonts.
const repo = join(here, '..');
const dest = join(repo, 'public', 'brand');
mkdirSync(dest, { recursive: true });
const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const sharp = require(require.resolve('sharp', { paths: [require.resolve('next')] }));

const f = (v) => +v.toFixed(2);
/**
 * The upper half of the torn ticket. The ticket is x 4–60, y 9–55, corner radius 6; the
 * tear runs (·,22)→(43,22)→(21,42)→(·,42) with width `g` and mitred corners, between
 * notches of radius `nr` at (4,22) and (60,42). The lower half is this, turned 180°.
 */
export function upperHalf(g, nr) {
  const h = g / 2;
  const u = [-22 / Math.hypot(22, 20), 20 / Math.hypot(22, 20)];
  const nv = [u[1], -u[0]]; // towards the upper half
  const base = [43 + h * nv[0], 22 + h * nv[1]];
  const onDiag = (y) => base[0] + ((y - base[1]) / u[1]) * u[0];
  const yTop = 22 - h, yBot = 42 - h;
  const dx = Math.sqrt(nr * nr - h * h);
  return `M10 9H54A6 6 0 0 1 60 15V${f(42 - nr)}A${nr} ${nr} 0 0 0 ${f(60 - dx)} ${f(yBot)}` +
    `H${f(onDiag(yBot))}L${f(onDiag(yTop))} ${f(yTop)}H${f(4 + dx)}A${nr} ${nr} 0 0 0 4 ${f(22 - nr)}V15A6 6 0 0 1 10 9Z`;
}
const FULL = { d: upperHalf(3.4, 4.4), shift: 1.1 };
const SMALL = { d: upperHalf(5.5, 5), shift: 0 };
export const INK = '#17151F', CORAL = '#FF6A4D', PAPER = '#F6F3EE', CORAL_DARK = '#FF7A5C';

const halves = ({ d, shift }, a, b, cls = ['', '']) =>
  `<path${cls[0]} fill="${a}" d="${d}"/><path${cls[1]} fill="${b}" transform="translate(${-shift} ${shift}) rotate(180 32 32)" d="${d}"/>`;
const svg = (body, vb = '0 0 64 64', extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>${body}</svg>\n`;

const files = {
  'zetix-mark.svg': svg(halves(FULL, INK, CORAL)),
  'zetix-mark-dark.svg': svg(halves(FULL, PAPER, CORAL_DARK)),
  // A tab follows the browser's own theme, so the favicon carries both.
  'zetix-favicon.svg': svg(`<style>.t{fill:${INK}}.s{fill:${CORAL}}@media (prefers-color-scheme:dark){.t{fill:${PAPER}}.s{fill:${CORAL_DARK}}}</style>` +
    halves(SMALL, '', '', [' class="t"', ' class="s"']).replace(/ fill=""/g, '')),
  'zetix-app-icon.svg': svg(`<rect width="64" height="64" rx="14" fill="${INK}"/><g transform="translate(32 32) scale(.74) translate(-32 -32)">${halves(FULL, PAPER, CORAL)}</g>`),
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(dest, name), body);

// iOS rounds the corners itself, so the touch icon is a full square.
const touch = svg(`<rect width="64" height="64" fill="${INK}"/><g transform="translate(32 32) scale(.7) translate(-32 -32)">${halves(FULL, PAPER, CORAL)}</g>`);
await sharp(Buffer.from(touch), { density: 900 }).resize(180, 180).png().toFile(join(dest, 'zetix-apple-icon.png'));

// Wordmark lockups for the README, in Sora as on the boards.
const lockup = (bg, a, b, color) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600&display=block" rel="stylesheet">
<style>*{margin:0}html,body{background:${bg}}body{display:inline-flex;align-items:center;gap:22px;padding:28px 40px 28px 32px}
span{font:600 76px/1 Sora;letter-spacing:-.03em;color:${color};margin-top:-6px}</style></head>
<body>${svg(halves(FULL, a, b), '0 0 64 64', ' width="88" height="88"')}<span>zetix</span></body></html>`;
const b = await chromium.launch();
const ctx = await b.newContext({ deviceScaleFactor: 2, viewport: { width: 800, height: 200 } });
for (const [name, html] of [['zetix-lockup.png', lockup('transparent', INK, CORAL, INK)], ['zetix-lockup-dark.png', lockup('transparent', PAPER, CORAL_DARK, PAPER)]]) {
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.locator('body').screenshot({ path: join(dest, name), omitBackground: true });
  await p.close();
}
await b.close();
console.log(JSON.stringify({ full: FULL, small: SMALL }, null, 1));
