"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { getOfflineDb, offlineSupported, type OutboxKind, type OutboxRecord } from "./db";
import { discardOp, retryAllFailed, retryOp } from "./outbox";
import { getServerSyncState, getSyncState, requestSync, startSyncLoop, subscribeSyncState } from "./sync-client";

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** navigator.onLine as React state (true during SSR). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const EMPTY: OutboxRecord[] = [];

/**
 * Live view of the offline outbox + sync controls. Mounting it starts the
 * sync loop (online listener, refData refresh, initial flush).
 */
export function useOutbox(opts: { kind?: OutboxKind } = {}) {
  const { kind } = opts;

  useEffect(() => startSyncLoop(), []);

  const items =
    useLiveQuery(async () => {
      if (!offlineSupported()) return EMPTY;
      const rows = await getOfflineDb().outbox.orderBy("createdAt").toArray();
      return kind ? rows.filter((r) => r.kind === kind) : rows;
    }, [kind]) ?? EMPTY;

  const sync = useSyncExternalStore(subscribeSyncState, getSyncState, getServerSyncState);
  const online = useOnline();

  const pending = items.filter((r) => r.status === "pending" || r.status === "syncing").length;
  const failed = items.filter((r) => r.status === "failed").length;

  /** Flush pending ops now (skips any backoff wait). Failed ops need retry/retryAllFailed. */
  const syncNow = useCallback(() => requestSync({ force: true }), []);
  const retryFailed = useCallback(async () => {
    await retryAllFailed();
    await requestSync({ force: true });
  }, []);

  return {
    items,
    active: items.filter((r) => r.status !== "done"),
    pending,
    failed,
    online,
    syncing: sync.running,
    lastError: sync.lastError,
    lastSyncedAt: sync.lastSyncedAt,
    nextRetryAt: sync.nextRetryAt,
    syncNow,
    retryFailed,
    retry: retryOp,
    discard: discardOp,
  };
}

/** Live status of one queued op (undefined until loaded / when not queued). */
export function useOutboxItem(id: string | null): OutboxRecord | undefined {
  return useLiveQuery(async () => {
    if (!id || !offlineSupported()) return undefined;
    return getOfflineDb().outbox.get(id);
  }, [id]);
}
