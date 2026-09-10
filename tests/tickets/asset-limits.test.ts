import { describe, expect, it } from 'vitest';
import {
  MAX_ASSET_BYTES,
  formatBytes,
  tooLargeMessage,
} from '@/lib/tickets/asset-limits';

/**
 * The limit and its wording are shared by the editor and the upload route, so
 * that an oversized background is refused with the same sentence wherever it is
 * caught (spec/tickets.md §10.3).
 */

describe('the ceiling', () => {
  it('stays under the platform body limit it exists to keep clear of', () => {
    // Vercel rejects a request body over about 4.5 MB before the route runs,
    // answering FUNCTION_PAYLOAD_TOO_LARGE as text/plain — which the editor
    // cannot parse, so the admin gets no number. Raising this past the platform
    // limit would put the failure back there silently.
    expect(MAX_ASSET_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });
});

describe('formatBytes', () => {
  it('drops the decimal when it earns nothing', () => {
    expect(formatBytes(4 * 1024 * 1024)).toBe('4 MB');
  });

  it('keeps one decimal otherwise', () => {
    expect(formatBytes(8_500_000)).toBe('8.1 MB');
  });
});

describe('tooLargeMessage', () => {
  it('names the file size and the limit, because "too large" alone is a guess', () => {
    expect(tooLargeMessage(8_500_000)).toBe('That file is 8.1 MB. The limit is 4 MB.');
  });
});
