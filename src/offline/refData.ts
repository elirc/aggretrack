import type { RefData } from "@/lib/services/sync";

import { getOfflineDb, offlineSupported, type RefDataRecord } from "./db";

/**
 * Reference-data snapshot (suppliers, commodities + grades, bag types, buying
 * points, warehouses + bins) cached per org so offline entry has its lists.
 * Refreshed from GET /api/sync whenever the app loads online.
 */

const CURRENT_ORG_KEY = "currentOrgId";

export async function getCurrentOrgId(): Promise<string | null> {
  if (!offlineSupported()) return null;
  try {
    const row = await getOfflineDb().meta.get(CURRENT_ORG_KEY);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function getRefData(orgId?: string | null): Promise<RefDataRecord | null> {
  if (!offlineSupported()) return null;
  try {
    const id = orgId ?? (await getCurrentOrgId());
    if (!id) return null;
    return (await getOfflineDb().refData.get(id)) ?? null;
  } catch {
    return null;
  }
}

let inflight: Promise<RefData | null> | null = null;

/** Fetch and store the snapshot. No-op (returns null) when offline or unauthenticated. */
export function refreshRefData(): Promise<RefData | null> {
  if (!offlineSupported() || !navigator.onLine) return Promise.resolve(null);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/sync", { method: "GET", credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as RefData;
      if (!data || typeof data.orgId !== "string") return null;
      const db = getOfflineDb();
      await db.transaction("rw", db.refData, db.meta, async () => {
        await db.refData.put({ ...data });
        await db.meta.put({ key: CURRENT_ORG_KEY, value: data.orgId });
      });
      return data;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
