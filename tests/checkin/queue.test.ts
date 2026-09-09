import { describe, expect, it } from 'vitest';
import {
  isManifestFresh,
  manifestStaleness,
  pendingScans,
  scanSummary,
  settledScanIds,
} from '@/lib/checkin/queue';
import type { QueuedScan } from '@/lib/checkin/store';

/**
 * The offline queue's decisions (spec/checkin.md §12.3).
 *
 * These are pure so they can be tested in CI — IndexedDB is not available
 * there, and everything that could actually be wrong about the queue is here
 * rather than inside the storage adapter.
 */

function queued(over: Partial<QueuedScan> & Pick<QueuedScan, 'id'>): QueuedScan {
  return {
    showId: 1,
    qrTokenSha256: 'a'.repeat(64),
    scannedAt: '2026-09-19T11:00:00.000Z',
    source: 'OFFLINE_SYNC',
    deviceId: 'usher-1',
    ...over,
  };
}

describe('what still needs sending', () => {
  it('is everything without a syncedAt', () => {
    const scans = [
      queued({ id: 1 }),
      queued({ id: 2, syncedAt: '2026-09-19T11:05:00.000Z' }),
      queued({ id: 3 }),
    ];
    expect(pendingScans(scans).map((s) => s.id)).toEqual([1, 3]);
  });

  it('summarises for the queue badge', () => {
    const scans = [queued({ id: 1 }), queued({ id: 2, syncedAt: '2026-09-19T11:05:00.000Z' })];
    expect(scanSummary(scans)).toEqual({ total: 2, pending: 1, synced: 1 });
  });
});

describe('manifest expiry', () => {
  const at = (iso: string) => new Date(iso);

  it('is fresh before show start plus the TTL', () => {
    expect(
      isManifestFresh({ expiresAt: '2026-09-20T04:00:00.000Z' }, at('2026-09-19T12:00:00.000Z')),
    ).toBe(true);
  });

  it('is stale after it', () => {
    expect(
      isManifestFresh({ expiresAt: '2026-09-19T12:00:00.000Z' }, at('2026-09-20T04:00:00.000Z')),
    ).toBe(false);
  });

  it('treats a manifest with no expiry as fresh', () => {
    // The cascade holds no value for checkin.manifest_ttl_hours yet. The
    // concert is not improved by a scanner that refuses to work until someone
    // fills in a settings field.
    expect(isManifestFresh({ expiresAt: null }, at('2030-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('warns on a stale manifest but never stops the door', () => {
    // Refusing to admit anybody is not the safer failure. The roster it holds
    // is still everyone who was issued a ticket.
    const state = manifestStaleness(
      { expiresAt: '2026-09-19T12:00:00.000Z', fetchedAt: '2026-09-19T09:00:00.000Z' },
      at('2026-09-20T04:00:00.000Z'),
    );
    expect(state.fresh).toBe(false);
    expect(state.warning).toContain('Scanning still works');
  });

  it('says plainly when there is no manifest at all', () => {
    expect(manifestStaleness(null).warning).toBe('No manifest on this device yet.');
  });
});

describe('settling the queue against receipts', () => {
  it('clears a recorded scan', () => {
    const pending = [queued({ id: 1 })];
    const ids = settledScanIds(pending, [{ qrTokenSha256: 'a'.repeat(64), outcome: 'RECORDED' }], pending);
    expect(ids).toEqual([1]);
  });

  it('clears NOT_FOUND and WRONG_SHOW too, because they are final answers', () => {
    // Retrying them on the next reconnect would leave them in the queue all
    // night, and a queue that never drains hides the scans that genuinely have
    // not synced.
    const pending = [queued({ id: 1 }), queued({ id: 2, qrTokenSha256: 'b'.repeat(64) })];
    const ids = settledScanIds(
      pending,
      [
        { qrTokenSha256: 'a'.repeat(64), outcome: 'NOT_FOUND' },
        { qrTokenSha256: 'b'.repeat(64), outcome: 'WRONG_SHOW' },
      ],
      pending,
    );
    expect(ids).toEqual([1, 2]);
  });

  it('settles two scans of one ticket separately', () => {
    // A ticket legitimately scanned twice has two queued rows; settling both on
    // one receipt would lose the second.
    const pending = [
      queued({ id: 1, scannedAt: '2026-09-19T11:00:00.000Z' }),
      queued({ id: 2, scannedAt: '2026-09-19T11:09:00.000Z' }),
    ];
    const ids = settledScanIds(
      pending,
      [
        { qrTokenSha256: 'a'.repeat(64), outcome: 'RECORDED' },
        { qrTokenSha256: 'a'.repeat(64), outcome: 'RECORDED' },
      ],
      pending,
    );
    expect(ids).toEqual([1, 2]);
  });

  it('ignores a response whose order does not match what was sent', () => {
    // Defensive: a receipt list that has drifted out of step with the batch
    // would otherwise mark the wrong scan as synced and lose a real admission.
    const pending = [queued({ id: 1 })];
    const ids = settledScanIds(pending, [{ qrTokenSha256: 'z'.repeat(64), outcome: 'RECORDED' }], pending);
    expect(ids).toEqual([]);
  });
});
