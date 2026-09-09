import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The iOS traps, as CI failures rather than rehearsal discoveries.
 *
 * **Why these are source assertions and not behavioural tests.** Only the
 * Chromium engine is installed in this environment, so nothing here can *run*
 * Safari. Every bug below is invisible on every engine available to CI and
 * total on roughly half the ushers' phones (context.md §6 question 7: around
 * six ushers, a mix of Android and iPhone). The choice is between a grep that
 * fails loudly and a note in a handoff that nobody reads — and this project
 * already settled that question in `tests/auth/manifest-call-site.test.ts`:
 * a note is not a gate.
 *
 * Each one costs a door. The rehearsal is 18 Sep, the day before the concert,
 * which is far too late to *find* any of them.
 */

const SCANNER_DIR = 'src/app/(scanner)';
const CHECKIN_LIB = 'src/lib/checkin';

async function sourceFiles(dir: string): Promise<{ path: string; code: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath ?? dir, e.name));

  return Promise.all(
    files.map(async (path) => ({
      path,
      // Comments stripped: these files *explain* the traps they avoid, and an
      // explanation must never read as an occurrence.
      code: (await readFile(path, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, ''),
    })),
  );
}

describe('viewport height', () => {
  it('never uses vh, which on iOS is the largest viewport', async () => {
    // Safari reports `100vh` as the height with the URL bar *hidden*, so a
    // `h-[100vh]` shell puts the bottom tab bar underneath the URL bar until
    // the user scrolls — and the scanner never scrolls. `svh` is the smallest
    // viewport and is what a fixed full-screen app wants.
    for (const { path, code } of await sourceFiles(SCANNER_DIR)) {
      expect(code, `${path} must use h-svh/dvh rather than vh`).not.toMatch(
        /\bh-\[?100vh\]?|\bmin-h-\[?100vh\]?|\bh-screen\b/,
      );
    }
  });

  it('sizes the scanner shell with svh', async () => {
    const shell = await readFile(
      'src/app/(scanner)/scan/(app)/[showId]/scanner-shell.tsx',
      'utf8',
    );
    expect(shell).toMatch(/h-svh/);
  });
});

describe('the camera element', () => {
  it('carries playsInline on every video in the scanner surface', async () => {
    // Without it, iOS Safari takes any playing <video> fullscreen — which
    // throws the usher out of the scanner on the very first frame. There is no
    // partial version of this failure and no way to see it on Chromium.
    for (const { path, code } of await sourceFiles(SCANNER_DIR)) {
      const videos = code.match(/<video[\s\S]*?\/?>/g) ?? [];
      for (const tag of videos) {
        expect(tag, `${path}: a <video> without playsInline is fullscreen on iOS`).toMatch(
          /playsInline/,
        );
        // `muted` is what allows autoplay without a gesture on both platforms.
        expect(tag, `${path}: a <video> without muted will not autoplay`).toMatch(/muted/);
      }
    }
  });

  it('has at least one video, so the assertion above is not vacuous', async () => {
    const files = await sourceFiles(SCANNER_DIR);
    const videos = files.flatMap(({ code }) => code.match(/<video/g) ?? []);
    expect(videos.length).toBeGreaterThan(0);
  });
});

describe('the notch and the home indicator', () => {
  it('claims the full display, which is what makes safe-area insets non-zero', async () => {
    // Without viewport-fit=cover an iPhone lays the page out inside the safe
    // area already and every env(safe-area-inset-*) reads 0 — so the padding
    // below would silently do nothing and the tab bar would sit above a
    // letterboxed strip.
    const layout = await readFile('src/app/(scanner)/layout.tsx', 'utf8');
    expect(layout).toMatch(/viewportFit:\s*'cover'/);
  });

  it('pays the bottom inset where the thumb actually lands', async () => {
    // The tab bar and the sheet's footer are the two controls a notched iPhone
    // would otherwise put under the home indicator.
    const shell = await readFile(
      'src/app/(scanner)/scan/(app)/[showId]/scanner-shell.tsx',
      'utf8',
    );
    const sheet = await readFile(
      'src/app/(scanner)/scan/(app)/[showId]/attendee-sheet.tsx',
      'utf8',
    );
    expect(shell).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(sheet).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});

describe('audio, which is blocked until a gesture', () => {
  it('unlocks the AudioContext from the Start scanning handler', async () => {
    // Creating it lazily on the first *scan* puts it outside any gesture, and
    // the symptom is the worst kind: the first several scans are silent and
    // nobody notices until the queue is moving (§12.2).
    const shell = await readFile(
      'src/app/(scanner)/scan/(app)/[showId]/scanner-shell.tsx',
      'utf8',
    );
    expect(shell).toMatch(/unlockAudio\(\)/);
    expect(shell).toMatch(/Start scanning/);
  });

  it('supports the webkit-prefixed AudioContext older iOS still exposes', async () => {
    const feedback = await readFile('src/lib/checkin/feedback.ts', 'utf8');
    expect(feedback).toMatch(/webkitAudioContext/);
  });
});

describe('regex features an older Safari cannot parse', () => {
  it('uses no lookbehind anywhere the browser will run', async () => {
    // `(?<=…)` and `(?<!…)` are a SyntaxError at *parse* time before Safari
    // 16.4 — the module dies rather than one match failing. The ushers bring
    // their own handsets, so the iOS floor is not ours to choose.
    const files = [...(await sourceFiles(SCANNER_DIR)), ...(await sourceFiles(CHECKIN_LIB))];
    for (const { path, code } of files) {
      expect(code, `${path} uses a lookbehind, which is fatal on Safari < 16.4`).not.toMatch(
        /\(\?<[=!]/,
      );
    }
  });
});

describe('storage that a browser is allowed to refuse', () => {
  it('guards every localStorage and IndexedDB access', async () => {
    // Safari in Private Browsing throws on these rather than returning null,
    // and a browser told to block site data does the same. An unguarded read
    // takes the whole scanner down on a phone that could otherwise scan.
    const files = [...(await sourceFiles(SCANNER_DIR)), ...(await sourceFiles(CHECKIN_LIB))];
    for (const { path, code } of files) {
      if (!/localStorage|indexedDB/.test(code)) continue;
      expect(code, `${path} touches storage and must handle a refusal`).toMatch(/try\s*\{/);
    }
  });
});

describe('zoom, on a screen tapped one-handed at speed', () => {
  it('is disabled for the scanner surface only', async () => {
    // A double-tap landing slightly off "Admit remaining 3" must not zoom the
    // viewfinder. Scoped to this layout: the admin console keeps pinch-zoom,
    // and iOS ignores the declaration for users who genuinely need to zoom.
    const layout = await readFile('src/app/(scanner)/layout.tsx', 'utf8');
    expect(layout).toMatch(/userScalable:\s*false/);

    const root = await readFile('src/app/layout.tsx', 'utf8');
    expect(root, 'the root layout must not disable zoom for every surface').not.toMatch(
      /userScalable/,
    );
  });
});
