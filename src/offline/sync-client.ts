import type { SyncOpResult, SyncResponse } from "@/lib/services/sync";

import { getOfflineDb, offlineSupported, type OutboxRecord } from "./db";
import { pruneDone } from "./outbox";
import { refreshRefData } from "./refData";

/**
 * Outbox flush loop. Triggers: `online` event, tab becoming visible, a new
 * queued op, and the manual "Sync now" button. Ops go to POST /api/sync in
 * batches of 10, oldest first; a transport failure backs off exponentially
 * (2s → 4s → … capped at 5 min). Per-op results: applied/duplicate → done,
 * error → failed (kept, with the server's message, until retried/discarded).
 */

export const SYNC_BATCH_SIZE = 10;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export type SyncState = {
  running: boolean;
  /** Last transport-level problem (not per-op errors). */
  lastError: string | null;
  lastSyncedAt: number | null;
  nextRetryAt: number | null;
};

let state: SyncState = { running: false, lastError: null, lastSyncedAt: null, nextRetryAt: null };
const subscribers = new Set<() => void>();

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn();
}

export function getSyncState(): SyncState {
  return state;
}

const SERVER_STATE: SyncState = { running: false, lastError: null, lastSyncedAt: null, nextRetryAt: null };
export function getServerSyncState(): SyncState {
  return SERVER_STATE;
}

export function subscribeSyncState(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let again = false;

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  clearRetry();
  failures += 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
  setState({ nextRetryAt: Date.now() + delay });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void requestSync();
  }, delay);
}

/** Ask for a flush. `force` skips the backoff wait (manual "Sync now"). */
export function requestSync(opts: { force?: boolean } = {}): Promise<void> {
  if (!offlineSupported()) return Promise.resolve();
  if (opts.force) {
    clearRetry();
    failures = 0;
    setState({ nextRetryAt: null });
  } else if (retryTimer) {
    return Promise.resolve(); // backing off — the timer will flush
  }
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        again = false;
        await flushOnce();
      } while (again && !retryTimer);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

function errorText(r: Extract<SyncOpResult, { status: "error" }>): string {
  return r.code === "VALIDATION" ? `Invalid: ${r.message}` : `${r.code}: ${r.message}`;
}

async function flushOnce(): Promise<void> {
  if (navigator.onLine === false) return;
  const db = getOfflineDb();

  // A tab closed mid-request leaves rows in `syncing`; replay is safe, so requeue them.
  await db.outbox.where("status").equals("syncing").modify({ status: "pending" });

  setState({ running: true });
  try {
    for (;;) {
      const batch: OutboxRecord[] = await db.outbox
        .where("status")
        .equals("pending")
        .sortBy("createdAt")
        .then((rows) => rows.slice(0, SYNC_BATCH_SIZE));
      if (batch.length === 0) break;

      const ids = batch.map((r) => r.id);
      await db.outbox.where("id").anyOf(ids).modify({ status: "syncing", updatedAt: Date.now() });

      let res: Response;
      try {
        res = await fetch("/api/sync", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ops: batch.map((r) => ({ clientId: r.id, kind: r.kind, payload: r.payload, orgId: r.orgId })),
          }),
        });
      } catch {
        await requeue(ids, "Network error — will retry");
        setState({ lastError: "Network error" });
        scheduleRetry();
        return;
      }

      if (res.status === 401) {
        await requeue(ids, "Sign in again to sync");
        setState({ lastError: "Signed out — sign in to sync" });
        return; // no point retrying until the user signs in
      }
      if (!res.ok) {
        await requeue(ids, `Server error ${res.status} — will retry`);
        setState({ lastError: `Server error ${res.status}` });
        scheduleRetry();
        return;
      }

      const body = (await res.json().catch(() => null)) as SyncResponse | null;
      const byId = new Map((body?.results ?? []).map((r) => [r.clientId, r] as const));
      const now = Date.now();
      await db.transaction("rw", db.outbox, async () => {
        for (const row of batch) {
          const r = byId.get(row.id);
          if (!r) {
            await db.outbox.update(row.id, { status: "pending", updatedAt: now, attempts: row.attempts + 1 });
          } else if (r.status === "error") {
            await db.outbox.update(row.id, { status: "failed", error: errorText(r), updatedAt: now, attempts: row.attempts + 1 });
          } else {
            await db.outbox.update(row.id, { status: "done", error: undefined, ref: r.ref, updatedAt: now, attempts: row.attempts + 1 });
          }
        }
      });
      if (batch.some((row) => !byId.has(row.id))) {
        scheduleRetry();
        return;
      }
      failures = 0;
      setState({ lastError: null, lastSyncedAt: now, nextRetryAt: null });
    }
    await pruneDone();
  } finally {
    setState({ running: false });
  }
}

async function requeue(ids: string[], error: string) {
  const db = getOfflineDb();
  const now = Date.now();
  await db.outbox
    .where("id")
    .anyOf(ids)
    .modify((row) => {
      row.status = "pending";
      row.error = error;
      row.updatedAt = now;
      row.attempts += 1;
    });
}

// ── lifecycle ────────────────────────────────────────────────────────────────

let users = 0;
let detach: (() => void) | null = null;

/**
 * Start the loop (ref-counted; safe to call from several mounted components).
 * Refreshes the reference-data snapshot and flushes immediately when online.
 */
export function startSyncLoop(): () => void {
  if (!offlineSupported()) return () => {};
  users += 1;
  if (users === 1) {
    const onOnline = () => {
      void refreshRefData();
      void requestSync({ force: true });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void requestSync();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    detach = () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
    if (navigator.onLine) {
      void refreshRefData();
      void requestSync();
    }
  }
  return () => {
    users -= 1;
    if (users === 0) {
      detach?.();
      detach = null;
    }
  };
}
