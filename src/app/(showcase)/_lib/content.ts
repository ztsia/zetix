/**
 * Everything the landing page points at (spec/v3.md §31), in one place for the owner to change.
 */

/** The public repository (docs/local.md §18.2). */
export const REPO_URL = 'https://github.com/ztsia/zetix';

/**
 * The walkthrough's YouTube id, uploaded by the owner on 10 Oct 2026 (docs/local.md §18.2). Left
 * empty, the page says the film is not up yet instead of embedding nothing.
 */
export const WALKTHROUGH_YOUTUBE_ID = 'tYE9JxSCns0';
export const WALKTHROUGH_LENGTH = '2:30';

/** The footer's credit. The owner may prefer a name and a portfolio here. */
export const AUTHOR = { name: 'ztsia', url: 'https://github.com/ztsia' } as const;

/** `ADMIN_LOGIN_PATH` and `SCANNER_LOGIN_PATH` in `@/lib/auth/guards`, which is server-only. */
export const SIGN_IN_PATH = '/login';
export const SCANNER_SIGN_IN_PATH = '/scan/login';

/** The demo's published sign-ins (docs/local.md §18.2). Passwords come from the environment. */
export const VIEWER_EMAIL = 'visitor@example.org';
export const USHERS = ['aisyah', 'jun-hao', 'priya'] as const;

/**
 * The hero loop, its 4:5 cut for phones, their posters and the walkthrough's cover. Rendered in
 * `video-edit/` and committed to `public/showcase/` once, when final: every version of a binary
 * stays in both repositories' history (spec/v3.md §31). Until then the folder is gitignored and the
 * page falls back to the demo's screenshots.
 */
export const MEDIA = {
  hero: '/showcase/zetix-hero.mp4',
  heroPoster: '/showcase/zetix-hero-poster.jpg',
  heroPortrait: '/showcase/zetix-hero-portrait.mp4',
  heroPortraitPoster: '/showcase/zetix-hero-portrait-poster.jpg',
  thumbnail: '/showcase/zetix-thumbnail.jpg',
} as const;
