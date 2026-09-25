import { describe, expect, it } from 'vitest';
import { filterKeyOf, parseTableState, tableStateToQuery } from '@/components/data-table/url-state';

/**
 * Table state in the URL (spec/v3.md §22.2): a view "encoded in the URL so it
 * can be linked". The page parses it and the client writes it, so the two must
 * round-trip, and a hand-edited link must degrade rather than fail the page.
 */
describe('table state in the URL', () => {
  it('round-trips page, size, sort, search and screen keys', () => {
    const state = parseTableState(
      { page: '3', size: '50', sort: '-deletedAt,label', q: 'tan', kind: 'seat', stray: 'x' },
      { extraKeys: ['kind'] },
    );
    expect(state).toEqual({
      pageIndex: 2,
      pageSize: 50,
      sorting: [
        { id: 'deletedAt', desc: true },
        { id: 'label', desc: false },
      ],
      search: 'tan',
      extra: { kind: 'seat' },
    });
    expect(parseTableState(Object.fromEntries(new URLSearchParams(tableStateToQuery(state))), {
      extraKeys: ['kind'],
    })).toEqual(state);
  });

  it('falls back to defaults on anything malformed', () => {
    const state = parseTableState({ page: '-4', size: '7', sort: 'a;drop' });
    expect(state).toMatchObject({ pageIndex: 0, pageSize: 25, sorting: [] });
    expect(tableStateToQuery(state)).toBe('');
  });

  it('keys the filter on search and screen keys, not on paging', () => {
    const a = parseTableState({ q: 'tan', page: '2', kind: 'party' }, { extraKeys: ['kind'] });
    const b = parseTableState({ q: 'tan', page: '5', kind: 'party' }, { extraKeys: ['kind'] });
    const c = parseTableState({ q: 'lim', kind: 'party' }, { extraKeys: ['kind'] });
    expect(filterKeyOf(a)).toBe(filterKeyOf(b));
    expect(filterKeyOf(a)).not.toBe(filterKeyOf(c));
  });
});
