/**
 * The console's colour themes and modes (spec/v3.md §29.5).
 *
 * A plain module shared by the provider (client), the pre-paint script (a
 * string the server renders) and the tests. The CSS for each theme is
 * `themes.css`; the default is no `data-theme` at all.
 */
export const CONSOLE_THEMES = [
  { id: 'default', label: 'Default' },
  { id: 'amber', label: 'Amber' },
  { id: 'amethyst', label: 'Amethyst' },
  { id: 'caffeine', label: 'Caffeine' },
  { id: 'claude', label: 'Claude' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'supabase', label: 'Supabase' },
  { id: 'vercel', label: 'Vercel' },
] as const;

export type ConsoleThemeId = (typeof CONSOLE_THEMES)[number]['id'];
export type ConsoleMode = 'light' | 'dark' | 'system';

export const CONSOLE_MODES: { id: ConsoleMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

/**
 * Where the choice is kept: this browser only. It changes nothing anyone else
 * sees, so it is neither a setting nor stored per account (§29.5).
 */
export const THEME_KEY = 'zetix.console.theme';
export const MODE_KEY = 'zetix.console.mode';

export function isThemeId(value: unknown): value is ConsoleThemeId {
  return CONSOLE_THEMES.some((theme) => theme.id === value);
}

export function isMode(value: unknown): value is ConsoleMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Sets the theme on <html> before the console paints, so a reload does not
 * flash the default. Rendered by the admin layout as an inline script: it runs
 * as the parser reaches it, ahead of the console's own markup. Storage can be
 * unavailable (a private window, blocked site data), so every read is guarded
 * and the default is what a failure leaves.
 */
export const PRE_PAINT_SCRIPT = `(() => {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    var mode = localStorage.getItem(${JSON.stringify(MODE_KEY)}) || 'system';
    var ids = ${JSON.stringify(CONSOLE_THEMES.map((theme) => theme.id))};
    if (theme && theme !== 'default' && ids.indexOf(theme) !== -1) root.setAttribute('data-theme', theme);
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();`;
