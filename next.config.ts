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
};

export default nextConfig;
