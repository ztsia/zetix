import { describe, expect, it } from 'vitest';
import { getConcertHeader } from '@/app/(admin)/admin/concerts/[concertId]/shows/queries';
import { loadPortalScreen } from '@/app/(admin)/admin/concerts/[concertId]/portal/queries';

describe('the concert lookups the 404-ing pages use', () => {
  it('finds concert 1 in zetix_qa', async () => {
    const header = await getConcertHeader(1);
    console.log('header:', JSON.stringify(header));
    const screen = await loadPortalScreen(1);
    console.log('screen:', JSON.stringify(screen)?.slice(0, 300));
    expect(header).not.toBeNull();
  });
});
