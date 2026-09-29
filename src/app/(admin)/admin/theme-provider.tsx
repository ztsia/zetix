'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  isMode,
  isThemeId,
  MODE_KEY,
  THEME_KEY,
  type ConsoleMode,
  type ConsoleThemeId,
} from './console-themes';

type ThemeState = {
  theme: ConsoleThemeId;
  mode: ConsoleMode;
  /** What `system` resolved to, or the mode itself. */
  dark: boolean;
  setTheme: (theme: ConsoleThemeId) => void;
  setMode: (mode: ConsoleMode) => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

// ---------------------------------------------------------------------------
// The store: this browser's stored choice, and the system's preference.
// ---------------------------------------------------------------------------

const QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();

function read<T>(key: string, valid: (value: unknown) => value is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

type Snapshot = { theme: ConsoleThemeId; mode: ConsoleMode; system: boolean };

/** A string, so an unchanged choice is an unchanged snapshot. */
function getSnapshot(): string {
  const theme = read(THEME_KEY, isThemeId, 'default');
  const mode = read(MODE_KEY, isMode, 'system');
  return `${theme}|${mode}|${window.matchMedia(QUERY).matches ? 1 : 0}`;
}

/** What the server rendered: the default look. The pre-paint script corrects the DOM before paint. */
const getServerSnapshot = () => 'default|system|0';

function parse(snapshot: string): Snapshot {
  const [theme, mode, system] = snapshot.split('|');
  return {
    theme: isThemeId(theme) ? theme : 'default',
    mode: isMode(mode) ? mode : 'system',
    system: system === '1',
  };
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const query = window.matchMedia(QUERY);
  query.addEventListener('change', onChange);
  // Another tab changing the choice changes this one too.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    query.removeEventListener('change', onChange);
    window.removeEventListener('storage', onChange);
  };
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage refused (a private window, blocked site data): the choice
    // cannot outlive the page, and without storage it cannot be read back
    // either, so it does not apply. The console stays on the default.
  }
  for (const listener of listeners) listener();
}

function apply({ theme, mode, system }: Snapshot): void {
  const root = document.documentElement;
  const dark = mode === 'dark' || (mode === 'system' && system);
  if (theme === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * The console's theme and mode (spec/v3.md §29.5), applied to <html>.
 *
 * On <html> rather than on a wrapper because dialogs, menus and popovers
 * portal to <body>, outside any wrapper the console could draw. **Only the
 * console mounts this**, and on unmount it takes the attributes away again, so
 * a client-side navigation to a registration form or the ticket page never
 * carries the console's look with it; the scanner switches its own dark mode
 * on its own wrapper.
 *
 * The pre-paint script (`PRE_PAINT_SCRIPT`) applies the stored choice before
 * the first paint. The effect below reads the store itself rather than the
 * rendered snapshot, because hydration renders the server's snapshot first and
 * applying that would flash the default for a frame.
 */
export function ConsoleThemeProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { theme, mode, system } = parse(snapshot);

  useEffect(() => {
    apply(parse(getSnapshot()));
  }, [snapshot]);

  useEffect(
    () => () => {
      const root = document.documentElement;
      root.removeAttribute('data-theme');
      root.classList.remove('dark');
      root.style.colorScheme = '';
    },
    [],
  );

  const setTheme = useCallback((next: ConsoleThemeId) => store(THEME_KEY, next), []);
  const setMode = useCallback((next: ConsoleMode) => store(MODE_KEY, next), []);
  const dark = mode === 'dark' || (mode === 'system' && system);

  const value = useMemo(
    () => ({ theme, mode, dark, setTheme, setMode }),
    [theme, mode, dark, setTheme, setMode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useConsoleTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error('useConsoleTheme outside ConsoleThemeProvider');
  return state;
}
