import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';
import { allFaceKeys, loadFace } from '@/lib/tickets/fonts';
import type { TicketData } from '@/lib/tickets/bindings';

/**
 * The ticket embeds whole, unmodified fonts.
 *
 * **This test exists because 29 other tests passed while the tickets were
 * unreadable.** pdf-lib's font subsetter produces a structurally perfect PDF —
 * correct glyph ids, correct positions, correct widths, a valid `ToUnicode` map
 * so text extraction returns exactly the right string — whose glyphs render
 * blank. "Wellington Mainwaring" printed as "ll g a war g". Page size, element
 * geometry, QR modules and baseline positions were all still correct, which is
 * precisely why nothing noticed.
 *
 * Several cleverer checks were tried and none held up: counting outlines in the
 * embedded program passes because a subset is internally consistent, and glyph
 * ids in the content stream index the *original* numbering rather than the
 * subset's, so following them proves nothing either.
 *
 * What is both simple and exact is the decision itself: **with `subset: false`,
 * pdf-lib embeds each font byte-for-byte as vendored.** So the invariant is
 * that the bytes in the PDF are the bytes on disk. Anyone reaching for
 * `subset: true` to reclaim the ~400KB turns this red, and the comment in
 * `render/index.ts` explains why they must not.
 */

const data: TicketData = {
  attendee: {
    fullName: 'Wellington Mainwaring',
    ticketCode: 'ORC-7K4Q',
    qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v',
  },
  registration: { contactName: 'Wellington Mainwaring' },
  player: { fullName: 'Siti Nurhaliza', instrument: 'Violin I' },
  show: {
    name: 'Autumn Serenade',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik PETRONAS',
    venueAddress: 'KLCC, Kuala Lumpur',
  },
  concert: { name: 'Lakeside Community Orchestra · Season 12', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
};

/**
 * Every stream in the file, inflated where it is compressed.
 *
 * `endstream` is located without requiring a newline before it: a binary font
 * program need not end with one, and requiring it silently skips exactly the
 * streams this test is looking for.
 */
function streams(pdf: Uint8Array): Buffer[] {
  const raw = Buffer.from(pdf);
  const text = raw.toString('latin1');
  const out: Buffer[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    const body = raw.subarray(start, end);
    try {
      out.push(inflateSync(body));
    } catch {
      out.push(body);
    }
  }
  return out;
}

/** TrueType programs embedded in the PDF, by their sfnt version tag. */
function embeddedFonts(pdf: Uint8Array): Buffer[] {
  return streams(pdf).filter((s) => s.length > 4 && s.readUInt32BE(0) === 0x00010000);
}

describe.each(DEFAULT_TEMPLATES.map((t) => [t.name, t.layout] as const))(
  '%s',
  (_name, layout) => {
    it('embeds fonts that are byte-identical to the vendored files', async () => {
      const { pdf } = await renderTicket({ layout, data });
      const embedded = embeddedFonts(pdf);

      expect(embedded.length, 'no embedded TrueType program in the PDF').toBeGreaterThan(0);

      const vendored = allFaceKeys().map((key) => Buffer.from(loadFace(key)));
      for (const program of embedded) {
        const match = vendored.find((v) => v.length === program.length && v.equals(program));
        expect(
          match,
          `an embedded font of ${program.length} bytes is not any vendored file ` +
            `(${vendored.map((v) => v.length).join(', ')}). pdf-lib's subsetter ` +
            'rewrites the program and its glyphs render blank — see ' +
            'src/lib/tickets/render/index.ts.',
        ).toBeDefined();
      }
    });

    it('embeds every face the layout asks for', async () => {
      // A missing face is the other half of the same failure: text drawn in a
      // font the PDF does not carry renders in whatever the viewer substitutes,
      // which is not what the editor showed (§10.4).
      const { pdf } = await renderTicket({ layout, data });
      const embedded = embeddedFonts(pdf);

      const families = new Set(
        layout.elements
          .filter((el) => el.type === 'TEXT')
          .map((el) => (el.type === 'TEXT' ? `${el.font_family}:${el.font_weight}` : '')),
      );
      expect(embedded.length).toBe(families.size);
    });
  },
);
