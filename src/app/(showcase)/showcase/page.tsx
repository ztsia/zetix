import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { Showcase } from '../_components/showcase';
import { MEDIA } from '../_lib/content';
import { isShowcase } from '../_lib/flag';

/**
 * The Zetix landing page (spec/v3.md §31). It is served at `/` by a rewrite in `next.config.ts`
 * where `SHOWCASE` is set, and is a 404 everywhere else.
 *
 * Its own route rather than a branch inside `src/app/page.tsx`: a page loads every client chunk its
 * imports reach, rendered or not, so a branch would have sent Motion and this page's scripts to
 * production's `/` with the placeholder. Here, nothing of the showcase reaches any other route.
 */
export default function ShowcasePage() {
  if (!isShowcase()) notFound();
  return <Showcase />;
}

const DESCRIPTION =
  'Open-source ticketing for free concerts: a party signs up, every guest gets a QR ticket, and the door works with no signal.';

export async function generateMetadata(): Promise<Metadata> {
  if (!isShowcase()) return {};
  const appUrl = process.env.APP_URL?.trim();
  return {
    title: { absolute: 'Zetix · Ticketing for free concerts' },
    description: DESCRIPTION,
    // The rest of the deployment is noindex (root layout); the landing page is its one public face.
    robots: { index: true, follow: true },
    ...(appUrl && { metadataBase: new URL(appUrl) }),
    // Served at `/`; this route's own path is an implementation detail.
    alternates: { canonical: '/' },
    openGraph: {
      title: 'Zetix: from sign-up to the door',
      description: DESCRIPTION,
      type: 'website',
      url: '/',
      images: [{ url: MEDIA.thumbnail, width: 1280, height: 720, alt: 'Zetix: from sign-up to the door' }],
    },
    twitter: { card: 'summary_large_image' },
  };
}

export function generateViewport(): Viewport {
  return isShowcase() ? { themeColor: '#17151F', colorScheme: 'dark light' } : {};
}
