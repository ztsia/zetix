import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';
import { publishedBookletFile, publishedBookletForShow } from '@/lib/portal/booklet';

/**
 * Which booklet a show's portal offers (spec/v2.md §13.3 item 2).
 *
 * **The property under test is that an unpublished booklet is invisible**, and
 * it is tested at the loader rather than at the page, because the loader is what
 * both the section and the file route call. A programme leaking before the
 * concert is the one failure this section can have.
 */

let concertId: number;
let showId: number;
let otherShowId: number;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Booklet');
  showId = await createShow(concertId, 100);
  otherShowId = await createShow(concertId, 100);
});

async function addBooklet(input: {
  title: string;
  showId?: number | null;
  published?: boolean;
  concertId?: number;
}): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    insert into booklets (concert_id, show_id, title, pdf_path, published)
    values (
      ${input.concertId ?? concertId},
      ${input.showId ?? null},
      ${input.title},
      ${`concerts/x/${input.title}.pdf`},
      ${input.published ?? false}
    )
    returning id
  `;
  return Number(rows[0].id);
}

const forShow = (id = showId) => publishedBookletForShow({ showId: id, concertId });

describe('a booklet is invisible until it is published', () => {
  it('offers nothing while the only booklet is unpublished', async () => {
    await addBooklet({ title: 'Programme', published: false });
    expect(await forShow()).toBeNull();
  });

  it('offers it once published', async () => {
    await addBooklet({ title: 'Programme', published: true });
    expect((await forShow())?.title).toBe('Programme');
  });

  it('stops offering it when it is unpublished again', async () => {
    const id = await addBooklet({ title: 'Programme', published: true });
    await sql`update booklets set published = false where id = ${id}`;
    expect(await forShow()).toBeNull();
  });
});

describe('a show-specific booklet wins over the concert-wide one', () => {
  it('prefers the booklet for this show', async () => {
    await addBooklet({ title: 'Concert programme', showId: null, published: true });
    await addBooklet({ title: 'Matinee programme', showId, published: true });
    expect((await forShow())?.title).toBe('Matinee programme');
  });

  it('falls back to the concert-wide one for a show with none of its own', async () => {
    await addBooklet({ title: 'Concert programme', showId: null, published: true });
    await addBooklet({ title: 'Matinee programme', showId, published: true });
    expect((await forShow(otherShowId))?.title).toBe('Concert programme');
  });

  it('does not offer another show s booklet', async () => {
    await addBooklet({ title: 'Matinee programme', showId: otherShowId, published: true });
    expect(await forShow()).toBeNull();
  });
});

describe('the file lookup re-checks everything the section checked', () => {
  /**
   * The route takes an id it derived from the show, but a lookup that trusted
   * that id would be one refactor away from taking one off a URL. These pin the
   * re-checks so that stays impossible.
   */
  it('refuses an unpublished booklet by id', async () => {
    const id = await addBooklet({ title: 'Programme', published: false });
    expect(
      await publishedBookletFile({ bookletId: id, showId, concertId }),
    ).toBeNull();
  });

  it('refuses a booklet belonging to another concert', async () => {
    const other = await createConcert('Elsewhere');
    const id = await addBooklet({ title: 'Someone else s', concertId: other, published: true });
    expect(
      await publishedBookletFile({ bookletId: id, showId, concertId }),
    ).toBeNull();
  });

  it('refuses a booklet scoped to a different show in the same concert', async () => {
    const id = await addBooklet({ title: 'Matinee', showId: otherShowId, published: true });
    expect(
      await publishedBookletFile({ bookletId: id, showId, concertId }),
    ).toBeNull();
  });

  it('returns the stored path for a booklet this show may see', async () => {
    const id = await addBooklet({ title: 'Programme', showId, published: true });
    const file = await publishedBookletFile({ bookletId: id, showId, concertId });
    expect(file?.pdfPath).toBe('concerts/x/Programme.pdf');
  });
});
