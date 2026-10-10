import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres', 'sharp', 'nodemailer'],

  /**
   * Fonts must be self-hosted and embedded: serverless runtimes have almost no
   * system fonts, and the PDF render must match the canvas editor
   * (spec/tickets.md §10.4). Files read from disk at runtime are not traced
   * automatically, and the failure only appears in production, in the render
   * path — i.e. on the day tickets go out.
   */
  outputFileTracingIncludes: {
    '/api/**': ['./src/assets/fonts/**/*'],
  },

  /**
   * `/` is the Zetix landing page only where `SHOWCASE` is set: the demo deployment (spec/v3.md
   * §31). Everywhere else it stays the placeholder in `src/app/page.tsx`. A rewrite rather than a
   * branch inside that page, because a page loads every client chunk its imports reach: this way
   * production's `/` loads nothing of the showcase. Blank reads as unset, and it is read at build,
   * as `src/app/(showcase)/_lib/flag.ts` does for the page itself.
   */
  async rewrites() {
    return {
      beforeFiles: process.env.SHOWCASE?.trim() ? [{ source: '/', destination: '/showcase' }] : [],
    };
  },
};

export default nextConfig;
