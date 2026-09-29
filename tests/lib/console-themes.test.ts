import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_THEMES,
  MODE_KEY,
  PRE_PAINT_SCRIPT,
  THEME_KEY,
} from '@/app/(admin)/admin/console-themes';
import { applyTheme, clearTheme, type ThemeRoot } from '@/app/(admin)/admin/theme-provider';

/**
 * The console's colour themes (spec/v3.md §29.5). The CSS is a pasted export,
 * so what is checked is the wiring around it: every theme listed has both its
 * blocks, every face a theme names is loaded, the sheet reaches only the
 * console, and the pre-paint script applies a stored choice and survives a
 * browser that refuses storage.
 */

const css = readFileSync('src/app/(admin)/admin/themes.css', 'utf8');

describe('the theme sheet', () => {
  it('has a light and a dark block for every listed theme but the default, and no others', () => {
    const blocks = [...css.matchAll(/:is\(:root, \.theme-swatch\)\[data-theme="(\w+)"\](\.dark)? \{/g)].map(
      (m) => `${m[1]}${m[2] ?? ''}`,
    );
    const expected = CONSOLE_THEMES.filter((t) => t.id !== 'default').flatMap((t) => [t.id, `${t.id}.dark`]);
    expect(blocks.sort()).toEqual(expected.sort());
  });

  it('loads every face a theme names, as a next/font variable on <html>', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    const faces = [...new Set([...css.matchAll(/var\((--font-[\w-]+)\)/g)].map((m) => m[1]))];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) expect(layout, face).toMatch(new RegExp(`variable:\\s*'${face}'`));
  });

  it('pins the form tokens for a themed console, so a form with no theme of its own looks as it does to the public', () => {
    expect(css).toMatch(/:root\[data-theme\] \{[^}]*--form-accent:/);
    expect(css).toMatch(/:root\[data-theme\]\.dark \{[^}]*--form-accent:/);
  });

  it('is imported by the admin layout and nothing else', () => {
    const importers = execSync(`grep -rlE "import .*themes\\.css" src --include=*.ts --include=*.tsx || true`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(importers).toEqual(['src/app/(admin)/admin/layout.tsx']);
  });
});

type FakeRoot = {
  attrs: Record<string, string>;
  classes: Set<string>;
  style: { colorScheme: string };
};

/** Runs the script against a stand-in for the browser, and returns what it did to <html>. */
function run(stored: Record<string, string>, prefersDark = false, storageThrows = false): FakeRoot {
  const root: FakeRoot = { attrs: {}, classes: new Set(), style: { colorScheme: '' } };
  const document = {
    documentElement: {
      setAttribute: (key: string, value: string) => (root.attrs[key] = value),
      classList: { toggle: (name: string, on: boolean) => (on ? root.classes.add(name) : root.classes.delete(name)) },
      style: root.style,
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error('SecurityError');
      return stored[key] ?? null;
    },
  };
  const window = { matchMedia: () => ({ matches: prefersDark }) };
  new Function('document', 'localStorage', 'window', PRE_PAINT_SCRIPT)(document, localStorage, window);
  return root;
}

describe('the pre-paint script', () => {
  it('applies a stored theme and mode', () => {
    const root = run({ [THEME_KEY]: 'amber', [MODE_KEY]: 'dark' });
    expect(root.attrs['data-theme']).toBe('amber');
    expect(root.classes.has('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('sets no attribute for the default theme, or for a theme it does not know', () => {
    expect(run({ [THEME_KEY]: 'default' }).attrs['data-theme']).toBeUndefined();
    expect(run({ [THEME_KEY]: 'bubblegum' }).attrs['data-theme']).toBeUndefined();
  });

  it('follows the system when nothing is stored', () => {
    expect(run({}, true).classes.has('dark')).toBe(true);
    expect(run({}, false).classes.has('dark')).toBe(false);
    expect(run({ [MODE_KEY]: 'light' }, true).classes.has('dark')).toBe(false);
  });

  it('does nothing, and does not throw, when storage is refused', () => {
    const root = run({}, true, true);
    expect(root.attrs).toEqual({});
    expect(root.classes.size).toBe(0);
  });
});

describe('the provider on <html>', () => {
  function fakeRoot() {
    const attrs: Record<string, string> = {};
    const classes = new Set<string>();
    const root = {
      setAttribute: (key: string, value: string) => void (attrs[key] = value),
      removeAttribute: (key: string) => void delete attrs[key],
      classList: {
        toggle: (name: string, on?: boolean) => (on ? classes.add(name) : classes.delete(name), Boolean(on)),
        remove: (name: string) => void classes.delete(name),
      },
      style: { colorScheme: '' },
    };
    return { root: root as unknown as ThemeRoot, attrs, classes, style: root.style };
  }

  it('applies a theme and mode, and clears every trace of them as the console leaves', () => {
    const { root, attrs, classes, style } = fakeRoot();
    applyTheme(root, { theme: 'graphite', mode: 'system', system: true });
    expect(attrs['data-theme']).toBe('graphite');
    expect(classes.has('dark')).toBe(true);
    expect(style.colorScheme).toBe('dark');

    clearTheme(root);
    expect(attrs).toEqual({});
    expect(classes.size).toBe(0);
    expect(style.colorScheme).toBe('');
  });

  it('removes the attribute for the default theme rather than setting "default"', () => {
    const { root, attrs } = fakeRoot();
    applyTheme(root, { theme: 'amber', mode: 'light', system: false });
    applyTheme(root, { theme: 'default', mode: 'light', system: false });
    expect(attrs).toEqual({});
  });

  it('clears on unmount: the provider’s cleanup effect is clearTheme', () => {
    // No DOM in this suite (see tests/forms/renderer.test.tsx for why), so the
    // wiring is read from the source; the Playwright pass exercises it live.
    const source = readFileSync('src/app/(admin)/admin/theme-provider.tsx', 'utf8');
    expect(source).toMatch(/useEffect\(\(\) => \(\) => clearTheme\(document\.documentElement\), \[\]\)/);
  });

  it('keeps a form drawn in a themed console on the public form’s face and radius', () => {
    expect(css).toMatch(/:root\[data-theme\] \[data-form-surface\] \{[^}]*--font-sans: var\(--font-geist\)[^}]*--radius:/);
    const builder = readFileSync('src/app/(admin)/admin/concerts/[concertId]/forms/builder/form-builder.tsx', 'utf8');
    expect(builder).toContain('data-form-surface');
  });
});
