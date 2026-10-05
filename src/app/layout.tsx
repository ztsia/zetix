import type { Metadata } from 'next';
import './globals.css';
import { Geist, Inter, Montserrat, Outfit } from "next/font/google";
import { cn } from "@/lib/utils";
import { HAS_MARK } from '@/lib/brand';

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

// The faces the console's themes name (`admin/themes.css`, spec/v3.md §29.5).
// Declared here because a theme sets `--font-sans` on <html>, so the variable
// it points at has to be defined there too. Not preloaded: only a console on
// one of those themes ever downloads them.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', preload: false });
const montserrat = Montserrat({ subsets: ['latin'], variable: '--font-montserrat', preload: false });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', preload: false });
// Geist again, under a name no theme overrides: a registration form drawn inside
// a themed console (the builder) keeps the public form's face.
const geistForm = Geist({ subsets: ['latin'], variable: '--font-geist', preload: false });

export const metadata: Metadata = {
  title: 'Zetix',
  // Every tokenised surface is noindex (spec/v2.md §13.3, ref.md §7).
  robots: { index: false, follow: false },
  // The Zetix copy's icons (`@/lib/brand`); it publishes without `favicon.ico`, so these are its only ones.
  ...(HAS_MARK && {
    icons: {
      icon: { url: '/brand/zetix-favicon.svg', type: 'image/svg+xml' },
      apple: '/brand/zetix-apple-icon.png',
    },
  }),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, geistForm.variable, inter.variable, montserrat.variable, outfit.variable)}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
