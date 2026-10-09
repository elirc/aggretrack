import { getOfflineDb, offlineSupported, type OutboxKind, type OutboxRecord } from "./db";
import { getCurrentOrgId } from "./refData";

/**
 * Outbox of mutations entered while offline. The row id IS the client uuid the
 * form generated at mount, so queueing the same submit twice is a no-op and
 * the server dedupes replays on the same key.
 */

export const NETWORK = Symbol("network");
export type NetworkFailure = typeof NETWORK;

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Run a server action unless the device is offline. A thrown call (fetch
 * failure — server actions reject on network errors) becomes NETWORK so the
 * caller can queue instead; a returned ActionResult passes through untouched.
 */
export async function tryOnline<R>(call: () => Promise<R>): Promise<R | NetworkFailure> {
  if (isOffline()) return NETWORK;
  try {
    return await call();
  } catch (err) {
    if (isOffline() || isNetworkError(err)) return NETWORK;
    throw err;
  }
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch: "Failed to fetch" / "NetworkError when attempting…"
  const msg = err instanceof Error ? err.message : String(err);
  return /network|failed to fetch|load failed|fetch failed|connection/i.test(msg);
}

export async function enqueueOp(op: {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  label?: string;
}): Promise<OutboxRecord> {
  if (!offlineSupported()) throw new Error("Offline queue unavailable in this browser");
  const db = getOfflineDb();
  const existing = await db.outbox.get(op.id);
  if (existing && existing.status !== "failed") return existing;
  const now = Date.now();
  const row: OutboxRecord = {
    id: op.id,
    kind: op.kind,
    payload: op.payload,
    label: op.label,
    status: "pending",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    attempts: existing?.attempts ?? 0,
    orgId: await getCurrentOrgId(),
  };
  await db.outbox.put(row);
  // Kick the sync loop (dynamic import keeps this module free of a cycle).
  void import("./sync-client").then((m) => m.requestSync());
  return row;
}

export async function listOutbox(): Promise<OutboxRecord[]> {
  if (!offlineSupported()) return [];
  return getOfflineDb().outbox.orderBy("createdAt").toArray();
}

export async function retryOp(id: string): Promise<void> {
  const db = getOfflineDb();
  await db.outbox.update(id, { status: "pending", error: undefined, updatedAt: Date.now() });
  void import("./sync-client").then((m) => m.requestSync({ force: true }));
}

export async function retryAllFailed(): Promise<void> {
  const db = getOfflineDb();
  await db.outbox.where("status").equals("failed").modify({ status: "pending", error: undefined, updatedAt: Date.now() });
}

export async function discardOp(id: string): Promise<void> {
  await getOfflineDb().outbox.delete(id);
}

/** Drop synced rows older than `maxAgeMs` (default 3 days) so the list stays short. */
export async function pruneDone(maxAgeMs = 3 * 24 * 60 * 60 * 1000): Promise<void> {
  if (!offlineSupported()) return;
  const cutoff = Date.now() - maxAgeMs;
  await getOfflineDb()
    .outbox.where("status")
    .equals("done")
    .filter((r) => r.updatedAt < cutoff)
    .delete();
}
