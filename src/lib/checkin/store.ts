import type { ManifestEntry } from './manifest';
import type { LocalCheckIn } from './evaluate';

/**
 * The phone's own storage: the manifest it admits against, and the queue of
 * scans waiting for a network (spec/checkin.md §12.3).
 *
 * **Deliberately a thin adapter with no decisions in it.** Everything that
 * could be wrong — whether a manifest is still usable, what is safe to drain,
 * how a receipt settles a queued scan — lives in `queue.ts` as pure functions,
 * because IndexedDB cannot run in the CI test environment and logic that hides
 * inside a database wrapper is logic nothing regression-tests. What is left
 * here is `put`, `get` and `delete`.
 *
 * **Storage can be absent, and that is not an error state to crash on.** Safari
 * in Private Browsing has historically thrown on `indexedDB.open`, and a
 * browser configured to block site data does the same. An usher whose phone
 * refuses storage must still be able to scan — so the fallback is an in-memory
 * store with `durable: false`, and the UI says plainly that this device will
 * lose its queue if the tab closes rather than silently pretending to persist.
 */

const DB_NAME = 'zetix-checkin';
const DB_VERSION = 1;
const MANIFESTS = 'manifests';
const QUEUE = 'queue';

/** A manifest as stored, with what the door needs to judge whether it is stale. */
export type StoredManifest = {
  showId: number;
  attendees: ManifestEntry[];
  /** Server-stamped (`/api/checkin/manifest`), never the device's clock. */
  fetchedAt: string;
  /** Show start + `checkin.manifest_ttl_hours`, resolved through the cascade. */
  expiresAt: string | null;
};

/** A scan the phone has accepted and the server has not yet acknowledged. */
export type QueuedScan = {
  /** Local id, assigned by the store. */
  id?: number;
  showId: number;
  qrTokenSha256: string;
  scannedAt: string;
  source: 'ONLINE' | 'OFFLINE_SYNC' | 'MANUAL';
  deviceId: string;
  overrideReason?: string | null;
  /** Set once a receipt comes back; kept, not deleted, so the tab can show history. */
  syncedAt?: string | null;
};

export type CheckinStore = {
  /** False when this device fell back to memory — the UI must say so. */
  durable: boolean;
  saveManifest(manifest: StoredManifest): Promise<void>;
  loadManifest(showId: number): Promise<StoredManifest | null>;
  enqueue(scan: QueuedScan): Promise<QueuedScan>;
  /** Everything this device has scanned for the show, synced or not. */
  allScans(showId: number): Promise<QueuedScan[]>;
  markSynced(ids: number[], at: string): Promise<void>;
};

export async function openCheckinStore(): Promise<CheckinStore> {
  const db = await openDatabase();
  return db ? indexedDbStore(db) : memoryStore();
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let idb: IDBFactory | undefined;
    try {
      // Reading the property itself throws in some locked-down configurations,
      // so even the feature test is guarded.
      idb = globalThis.indexedDB;
    } catch {
      resolve(null);
      return;
    }
    if (!idb) {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANIFESTS)) {
        db.createObjectStore(MANIFESTS, { keyPath: 'showId' });
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        const queue = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
        queue.createIndex('showId', 'showId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Safari Private Browsing can leave the request pending rather than
    // erroring. A door cannot wait: fall back and carry on scanning.
    setTimeout(() => resolve(request.readyState === 'done' ? request.result : null), 2_000);
  });
}

function indexedDbStore(db: IDBDatabase): CheckinStore {
  const run = <T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  return {
    durable: true,

    async saveManifest(manifest) {
      await run(MANIFESTS, 'readwrite', (s) => s.put(manifest));
    },

    async loadManifest(showId) {
      const found = await run<StoredManifest | undefined>(MANIFESTS, 'readonly', (s) =>
        s.get(showId),
      );
      return found ?? null;
    },

    async enqueue(scan) {
      const id = await run<IDBValidKey>(QUEUE, 'readwrite', (s) => s.add(scan));
      return { ...scan, id: Number(id) };
    },

    async allScans(showId) {
      const rows = await run<QueuedScan[]>(QUEUE, 'readonly', (s) =>
        s.index('showId').getAll(showId),
      );
      return rows ?? [];
    },

    async markSynced(ids, at) {
      await Promise.all(
        ids.map(
          (id) =>
            new Promise<void>((resolve, reject) => {
              const tx = db.transaction(QUEUE, 'readwrite');
              const store = tx.objectStore(QUEUE);
              const get = store.get(id);
              get.onsuccess = () => {
                const row = get.result as QueuedScan | undefined;
                if (!row) return resolve();
                const put = store.put({ ...row, syncedAt: at });
                put.onsuccess = () => resolve();
                put.onerror = () => reject(put.error);
              };
              get.onerror = () => reject(get.error);
            }),
        ),
      );
    },
  };
}

/**
 * The fallback when this device will not give us storage.
 *
 * It keeps the scanner fully working for the life of the tab, which is the
 * outcome that matters at a door. What it cannot survive is a reload, and the
 * shell surfaces `durable: false` so the operator is told that rather than
 * discovering it.
 */
function memoryStore(): CheckinStore {
  const manifests = new Map<number, StoredManifest>();
  const queue: QueuedScan[] = [];
  let nextId = 1;

  return {
    durable: false,
    async saveManifest(manifest) {
      manifests.set(manifest.showId, manifest);
    },
    async loadManifest(showId) {
      return manifests.get(showId) ?? null;
    },
    async enqueue(scan) {
      const stored = { ...scan, id: nextId++ };
      queue.push(stored);
      return stored;
    },
    async allScans(showId) {
      return queue.filter((s) => s.showId === showId);
    },
    async markSynced(ids, at) {
      for (const row of queue) {
        if (row.id !== undefined && ids.includes(row.id)) row.syncedAt = at;
      }
    },
  };
}

/** Queued scans as the evaluator wants them (spec/checkin.md §12.1). */
export function toLocalCheckIns(scans: readonly QueuedScan[]): LocalCheckIn[] {
  return scans.map((s) => ({
    qrTokenSha256: s.qrTokenSha256,
    scannedAt: s.scannedAt,
    source: s.source,
  }));
}
