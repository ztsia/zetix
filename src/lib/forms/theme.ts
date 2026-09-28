/**
 * Per-form themes (spec/v3.md §25.6): a banner image, the colour taken from
 * it, and the admin's override.
 *
 * **A theme sets `--form-*` tokens on the form's wrapper and nothing else**
 * (`globals.css`, the `forms-google-layout` handoff): every form screen reads
 * those tokens, so the look changes without any component knowing a theme
 * exists. No `server-only` — the public form and the admin preview both read it.
 *
 * **The colour is contrast-checked before it becomes button text.** The
 * accent is the button's background, so its foreground is whichever of white
 * or near-black reads better; when neither reaches WCAG AA for normal text
 * (4.5:1) the accent is darkened until white does. A banner's dominant colour
 * is often a mid-tone that fails both.
 */

export type FormTheme = {
  /** Storage path of the banner in the public form-assets bucket, or null. */
  bannerPath: string | null;
  /** The dominant colour of the banner, `#rrggbb`, as extracted on upload. */
  colour: string | null;
  /** The admin's own colour, `#rrggbb`, which wins over the extracted one. */
  colourOverride: string | null;
};

const HEX = /^#[0-9a-f]{6}$/i;

/** A stored theme, defensively: anything malformed reads as "no theme". */
export function parseTheme(raw: unknown): FormTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
  const bannerPath =
    typeof value.bannerPath === 'string' && /^[A-Za-z0-9/_.-]{1,256}$/.test(value.bannerPath) && !value.bannerPath.includes('..')
      ? value.bannerPath
      : null;
  const theme = { bannerPath, colour: hex(value.colour), colourOverride: hex(value.colourOverride) };
  return theme.bannerPath || theme.colour || theme.colourOverride ? theme : null;
}

export function isHexColour(value: string): boolean {
  return HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** AA for normal-size text: what a button label needs. */
export const MIN_CONTRAST = 4.5;
const WHITE = '#ffffff';
const INK = '#111111';

/**
 * The accent actually used and the text on it. The accent is kept when white
 * or ink reads on it at AA; otherwise it is darkened in small steps until
 * white does — so a theme can make a form darker than its banner, never
 * unreadable.
 */
export function readableAccent(colour: string): { accent: string; foreground: string; adjusted: boolean } {
  const onWhite = contrastRatio(colour, WHITE);
  const onInk = contrastRatio(colour, INK);
  if (onWhite >= MIN_CONTRAST) return { accent: colour, foreground: WHITE, adjusted: false };
  if (onInk >= MIN_CONTRAST) return { accent: colour, foreground: INK, adjusted: false };
  let rgb = channels(colour);
  for (let step = 0; step < 40; step += 1) {
    rgb = rgb.map((c) => c * 0.92) as [number, number, number];
    const next = toHex(rgb);
    if (contrastRatio(next, WHITE) >= MIN_CONTRAST) return { accent: next, foreground: WHITE, adjusted: true };
  }
  return { accent: INK, foreground: WHITE, adjusted: true };
}

/** The colour a theme puts on the form: the override, else the banner's. */
export function themeColour(theme: FormTheme | null): string | null {
  return theme?.colourOverride ?? theme?.colour ?? null;
}

/**
 * The `--form-*` tokens a theme sets on the form wrapper, or null for the
 * default look. Only the accent family changes: the canvas and cards stay the
 * system's, so light and dark mode both still hold.
 */
export function themeTokens(theme: FormTheme | null): Record<string, string> | null {
  const colour = themeColour(theme);
  if (!colour) return null;
  const { accent, foreground } = readableAccent(colour);
  return {
    '--form-accent': accent,
    '--form-accent-foreground': foreground,
    '--form-accent-soft': `color-mix(in oklch, ${accent} 10%, transparent)`,
    '--form-focus': accent,
  };
}
