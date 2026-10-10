import { REPO_URL, SCANNER_SIGN_IN_PATH, SIGN_IN_PATH, USHERS, VIEWER_EMAIL } from '../_lib/content';
import { TICKET_CODE } from '../_lib/guest';
import { qrPath } from '../_lib/qr';
import { Curtain } from './curtain';
import type { DemoAccess } from './demo-dialog';
import { Door } from './door';
import { Encore } from './encore';
import { Film } from './film';
import { Footer } from './footer';
import { Hero } from './hero';
import { Nav } from './nav';
import { Notes } from './notes';
import { Programme } from './programme';
import { ShowcaseRoot } from './root';
import { UsherCard } from './usher-card';

/**
 * The Zetix landing page (spec/v3.md §31), laid out as the evening's programme and lit the way the
 * film is: down for the overture, up for the work, down for the door, up for the encore, down for
 * the curtain.
 *
 * The demo's passwords are environment values (docs/local.md §18.2), read here at build time: the
 * viewer's is published on purpose, and a blank one sends people to the README instead.
 */
export function Showcase() {
  const appUrl = process.env.APP_URL?.trim() || null;
  const demo: DemoAccess = {
    signInPath: SIGN_IN_PATH,
    scannerPath: SCANNER_SIGN_IN_PATH,
    viewerEmail: VIEWER_EMAIL,
    viewerPassword: process.env.DEMO_VIEWER_PASSWORD?.trim() || null,
    ushers: USHERS,
    usherCode: process.env.DEMO_OPERATOR_CODE?.trim() || null,
    readmeUrl: `${REPO_URL}#try-it`,
  };
  const scannerUrl = appUrl ? new URL(SCANNER_SIGN_IN_PATH, appUrl).toString() : null;
  // Eleanor's ticket, which her page in movement III shows too (`/showcase/phone/ticket`).
  const ticket = qrPath(TICKET_CODE);

  return (
    <ShowcaseRoot demo={demo}>
      <a href="#main" className="zx-skip">
        Skip to the page
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Programme />
        <Notes />
        <Door qr={ticket}>
          {demo.usherCode && (
            <UsherCard
              code={demo.usherCode}
              ushers={USHERS}
              path={scannerUrl ?? SCANNER_SIGN_IN_PATH}
              qr={scannerUrl ? qrPath(scannerUrl) : null}
            />
          )}
        </Door>
        <Encore />
        <Film />
        <Curtain />
      </main>
      <Footer />
    </ShowcaseRoot>
  );
}
