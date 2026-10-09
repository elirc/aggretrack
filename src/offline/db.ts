import Dexie, { type EntityTable } from "dexie";

import type { RefData } from "@/lib/services/sync";

/**
 * Browser-only IndexedDB store (ARCHITECTURE §Offline / PWA, INTEGRATIONS §9).
 * Opened lazily so importing this module during SSR never touches IndexedDB.
 */

export type OutboxKind = "purchase" | "receipt" | "dispatch";
export type OutboxStatus = "pending" | "syncing" | "failed" | "done";

export type OutboxRecord = {
  /** Client-generated uuid — the server-side idempotency key (PK). */
  id: string;
  kind: OutboxKind;
  payload: unknown;
  status: OutboxStatus;
  error?: string;
  /** Short human label for the outbox list ("Purchase · Musa Bello · 3 lines"). */
  label?: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  /** Org the op was queued under (null when no refData snapshot exists yet). */
  orgId: string | null;
  /** Server reference once synced (purchase / dispatch id + number). */
  ref?: { id: string; number: string | null };
};

export type RefDataRecord = RefData & {
  /** Primary key: the organisation the snapshot belongs to. */
  orgId: string;
};

/** Small key/value table: `currentOrgId` = org of the last refData refresh. */
export type MetaRecord = { key: string; value: string };

export type OfflineDb = Dexie & {
  outbox: EntityTable<OutboxRecord, "id">;
  refData: EntityTable<RefDataRecord, "orgId">;
  meta: EntityTable<MetaRecord, "key">;
};

let instance: OfflineDb | null = null;

export function offlineSupported(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

export function getOfflineDb(): OfflineDb {
  if (!offlineSupported()) throw new Error("IndexedDB is not available in this environment");
  if (!instance) {
    const db = new Dexie("aggretrack-offline") as OfflineDb;
    db.version(1).stores({
      outbox: "id, kind, status, createdAt, orgId",
      refData: "orgId, fetchedAt",
      meta: "key",
    });
    instance = db;
  }
  return instance;
}
