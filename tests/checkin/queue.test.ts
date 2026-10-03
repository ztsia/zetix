import { describe, expect, it } from 'vitest';
import {
  isManifestFresh,
  manifestStaleness,
  pendingScans,
  scanSummary,
  othersWaiting,
  ownScans,
  prepareBatch,
  refusedScans,
  settleReceipts,
} from '@/lib/checkin/queue';
import type { QueuedScan, QueuedWalkIn } from '@/lib/checkin/store';

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
    expect(scanSummary(scans)).toEqual({ total: 2, pending: 1, synced: 1, refused: 0 });
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
  it('syncs a recorded scan, and one the server already had', () => {
    const pending = [queued({ id: 1 }), queued({ id: 2 })];
    const result = settleReceipts(pending, [
      { index: 0, outcome: 'RECORDED' },
      { index: 1, outcome: 'ALREADY_SYNCED' },
    ]);
    expect(result).toEqual({ synced: [1, 2], refused: [] });
  });

  it('sets NOT_FOUND and WRONG_SHOW aside as refused, with a reason, rather than settling them silently', () => {
    // spec/v3.md §32.2: a queued admission is a person in the hall. A seat the
    // server cannot find is something the desk must hear about, and re-sending
    // it would only be refused again.
    const pending = [queued({ id: 1 }), queued({ id: 2, qrTokenSha256: 'b'.repeat(64) })];
    const result = settleReceipts(pending, [
      { index: 0, outcome: 'NOT_FOUND' },
      { index: 1, outcome: 'WRONG_SHOW', showName: 'Matinee' },
    ]);
    expect(result.synced).toEqual([]);
    expect(result.refused.map((r) => r.id)).toEqual([1, 2]);
    expect(result.refused[1].reason).toContain('Matinee');
  });

  it('settles two scans of one ticket separately', () => {
    // A ticket legitimately scanned twice has two queued rows; settling both on
    // one receipt would lose the second.
    const pending = [
      queued({ id: 1, scannedAt: '2026-09-19T11:00:00.000Z' }),
      queued({ id: 2, scannedAt: '2026-09-19T11:09:00.000Z' }),
    ];
    const result = settleReceipts(pending, [
      { index: 0, outcome: 'RECORDED' },
      { index: 1, outcome: 'RECORDED' },
    ]);
    expect(result.synced).toEqual([1, 2]);
  });

  it('leaves a row pending when no receipt names it', () => {
    // A receipt list that drifted out of step with the batch would otherwise
    // mark the wrong scan as synced and lose a real admission.
    const pending = [queued({ id: 1 }), queued({ id: 2 })];
    const result = settleReceipts(pending, [{ index: 1, outcome: 'RECORDED' }]);
    expect(result).toEqual({ synced: [2], refused: [] });
  });
});

describe('one bad row never blocks the queue (spec/v3.md §32.2)', () => {
  it('a batch holding one invalid row still settles the valid ones', () => {
    // The P0 the research found: a seat with no ticket was queued with a null
    // digest, the route refused the whole batch with a 400, and the row rode
    // along in every later batch, so nothing this phone admitted afterwards
    // ever reached the server.
    const pending = [
      queued({ id: 1 }),
      queued({ id: 2, qrTokenSha256: null }), // queued by the old build
      queued({ id: 3, qrTokenSha256: 'c'.repeat(64) }),
    ];

    const { send, setAside } = prepareBatch(pending);
    expect(send.map((s) => s.id)).toEqual([1, 3]);
    expect(setAside.map((s) => s.id)).toEqual([2]);

    const result = settleReceipts(send, [
      { index: 0, outcome: 'RECORDED' },
      { index: 1, outcome: 'RECORDED' },
    ]);
    expect(result.synced).toEqual([1, 3]);
  });

  it('a row the server refuses is set aside and never sent again', () => {
    const pending = [queued({ id: 1 }), queued({ id: 2 })];
    const { refused } = settleReceipts(pending, [
      { index: 0, outcome: 'REFUSED' },
      { index: 1, outcome: 'RECORDED' },
    ]);
    expect(refused.map((r) => r.id)).toEqual([1]);

    const after = [
      { ...pending[0], refusedAt: '2026-09-19T11:01:00.000Z', refusedReason: refused[0].reason },
      { ...pending[1], syncedAt: '2026-09-19T11:01:00.000Z' },
    ];
    expect(pendingScans(after)).toEqual([]);
    expect(refusedScans(after).map((s) => s.id)).toEqual([1]);
    expect(scanSummary(after)).toEqual({ total: 2, pending: 0, synced: 1, refused: 1 });
  });

  it('sends a seat with no ticket by its attendee id', () => {
    const { send, setAside } = prepareBatch([
      queued({ id: 1, attendeeId: 42, qrTokenSha256: null, overrideReason: 'No ticket issued' }),
    ]);
    expect(send.map((s) => s.id)).toEqual([1]);
    expect(setAside).toEqual([]);
  });
});

describe('queued admissions belong to whoever made them (spec/v3.md §32.2)', () => {
  const rows = [
    queued({ id: 1, operatorId: 'wei', operatorName: 'Wei Ling' }),
    queued({ id: 2, operatorId: 'wei', operatorName: 'Wei Ling' }),
    queued({ id: 3, operatorId: 'sam', operatorName: 'Sam' }),
    queued({ id: 4 }), // queued before rows were tagged
    queued({ id: 5, operatorId: 'wei', operatorName: 'Wei Ling', syncedAt: '2026-09-19T11:05:00.000Z' }),
  ];

  it('sends only the signed-in operator`s rows, and untagged ones', () => {
    expect(ownScans(rows, 'sam').map((s) => s.id)).toEqual([3, 4]);
  });

  it('never re-attributes another operator`s unsynced rows; it names them instead', () => {
    expect(othersWaiting(rows, 'sam')).toEqual([{ operatorName: 'Wei Ling', count: 2 }]);
    expect(othersWaiting(rows, 'wei')).toEqual([{ operatorName: 'Sam', count: 1 }]);
  });
});

describe('walk-ins left by somebody else are named too (QA, spec/v3.md §32.2)', () => {
  it('counts another operator`s unsynced walk-in beside their scans', () => {
    const walkIn = (over: Partial<QueuedWalkIn>): QueuedWalkIn => ({
      clientId: crypto.randomUUID(),
      showId: 1,
      headcount: 2,
      label: null,
      admittedAt: '2026-09-19T11:00:00.000Z',
      deviceId: 'usher-1',
      operatorId: 'wei',
      operatorName: 'Wei Ling',
      ...over,
    });
    expect(
      othersWaiting([], 'sam', [walkIn({}), walkIn({ syncedAt: '2026-09-19T11:01:00.000Z' }), walkIn({ operatorId: 'sam', operatorName: 'Sam' })]),
    ).toEqual([{ operatorName: 'Wei Ling', count: 1 }]);
  });
});
