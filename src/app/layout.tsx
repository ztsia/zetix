import type { Metadata } from 'next';
import './globals.css';
import { Geist, Inter, Montserrat, Outfit } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

// The faces the console's themes name (`admin/themes.css`, spec/v3.md §29.5).
// Declared here because a theme sets `--font-sans` on <html>, so the variable
// it points at has to be defined there too. Not preloaded: only a console on
// one of those themes ever downloads them.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', preload: false });
const montserrat = Montserrat({ subsets: ['latin'], variable: '--font-montserrat', preload: false });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', preload: false });

export const metadata: Metadata = {
  title: 'Zetix',
  // Every tokenised surface is noindex (spec/v2.md §13.3, ref.md §7).
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, inter.variable, montserrat.variable, outfit.variable)}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
