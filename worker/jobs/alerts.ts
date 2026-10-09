/**
 * alerts.scan (cron ~15 min). For every organisation, run P2-B's typed scan
 * queries (src/lib/services/alertRules.ts → scanAlerts, which reads the org's
 * organisation_settings thresholds or the defaults) and turn the rows into
 * org-wide notifications (user_id null):
 *  - low stock:  one per commodity below low_stock_threshold_kg → /stock?commodity=…
 *  - old stock:  AGGREGATED per commodity × warehouse (lots older than
 *                old_stock_days with stock on hand) → /stock/ageing?commodity=…&warehouse=…
 *  - capacity:   one per warehouse ≥ capacity_alert_percent → /stock?warehouse=…
 * Dedupe (notifyOnce): skip when an UNREAD notification with the same
 * (org, type, link, user) exists — once it is read, the next scan may raise it again.
 * (P4-D reconciliation of P1-D's raw-SQL skeleton.)
 */
import type { Job } from "pg-boss";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../../src/db/client";
import { lots, notifications, organization } from "../../src/db/schema";
import { kgToGrams } from "../../src/lib/domain/units";
import type { AlertsScanJob } from "../../src/lib/jobs";
import { scanAlerts, type OldStockRow } from "../../src/lib/services/alertRules";
import { pdfKg } from "../../src/pdf/format";

type NotificationType = (typeof notifications.$inferInsert)["type"];

export interface NotifyInput {
  orgId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  link: string;
}

/** Insert unless an unread notification with the same org/type/link/user exists. Returns true if inserted. */
export async function notifyOnce(dbx: DbOrTx, n: NotifyInput): Promise<boolean> {
  const userId = n.userId ?? null;
  const [existing] = await dbx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.organisationId, n.orgId),
        eq(notifications.type, n.type),
        eq(notifications.link, n.link),
        isNull(notifications.readAt),
        userId === null ? isNull(notifications.userId) : eq(notifications.userId, userId),
      ),
    )
    .limit(1);
  if (existing) return false;
  await dbx.insert(notifications).values({
    organisationId: n.orgId,
    userId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    link: n.link,
  });
  return true;
}

export type OldStockGroup = {
  commodityId: string;
  commodityName: string;
  warehouseId: string;
  warehouseName: string;
  lotCount: number;
  onHandGrams: number;
  oldestAgeDays: number;
};

/** Collapse per-lot old-stock rows into one group per commodity × warehouse. */
export function groupOldStock(rows: OldStockRow[], commodityByLot: Map<string, string>): OldStockGroup[] {
  const groups = new Map<string, OldStockGroup>();
  for (const r of rows) {
    const commodityId = commodityByLot.get(r.lotId);
    if (!commodityId) continue;
    const key = `${commodityId}|${r.warehouseId}`;
    const g = groups.get(key);
    if (g) {
      g.lotCount++;
      g.onHandGrams += r.onHandGrams;
      g.oldestAgeDays = Math.max(g.oldestAgeDays, r.ageDays);
    } else {
      groups.set(key, {
        commodityId,
        commodityName: r.commodityName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        lotCount: 1,
        onHandGrams: r.onHandGrams,
        oldestAgeDays: r.ageDays,
      });
    }
  }
  return [...groups.values()];
}

export type OrgScanResult = { lowStock: number; oldStock: number; capacity: number };

/** Scan one organisation and write its notifications. Returns how many were inserted per type. */
export async function scanOrgAlerts(dbx: DbOrTx, orgId: string, now: Date = new Date()): Promise<OrgScanResult> {
  const scan = await scanAlerts(dbx, orgId, now);
  const out: OrgScanResult = { lowStock: 0, oldStock: 0, capacity: 0 };

  for (const r of scan.lowStock) {
    const ok = await notifyOnce(dbx, {
      orgId,
      type: "low_stock",
      title: `Low stock: ${r.commodityName}`,
      body: `${pdfKg(r.onHandGrams)} kg on hand (threshold ${pdfKg(kgToGrams(r.thresholdKg))} kg).`,
      link: `/stock?commodity=${r.commodityId}`,
    });
    if (ok) out.lowStock++;
  }

  if (scan.oldStock.length > 0) {
    // alertRules' OldStockRow carries the commodity name only; resolve ids (org-scoped) for the link.
    const lotIds = [...new Set(scan.oldStock.map((r) => r.lotId))];
    const lotRows = await dbx
      .select({ id: lots.id, commodityId: lots.commodityId })
      .from(lots)
      .where(and(eq(lots.organisationId, orgId), inArray(lots.id, lotIds)));
    const commodityByLot = new Map(lotRows.map((l) => [l.id, l.commodityId]));
    for (const g of groupOldStock(scan.oldStock, commodityByLot)) {
      const lotsLabel = g.lotCount === 1 ? "1 lot" : `${g.lotCount} lots`;
      const ok = await notifyOnce(dbx, {
        orgId,
        type: "old_stock",
        title: `Old stock: ${g.commodityName} at ${g.warehouseName}`,
        body: `${lotsLabel}, ${pdfKg(g.onHandGrams)} kg on hand; oldest ${g.oldestAgeDays} days.`,
        link: `/stock/ageing?commodity=${g.commodityId}&warehouse=${g.warehouseId}`,
      });
      if (ok) out.oldStock++;
    }
  }

  for (const r of scan.nearCapacity) {
    const ok = await notifyOnce(dbx, {
      orgId,
      type: "capacity",
      title: `Warehouse near capacity: ${r.warehouseName}`,
      body: `${pdfKg(r.onHandGrams)} kg of ${pdfKg(kgToGrams(r.capacityKg))} kg (${r.usedPercent}% full).`,
      link: `/stock?warehouse=${r.warehouseId}`,
    });
    if (ok) out.capacity++;
  }

  return out;
}

export type AlertsScanResult = { orgs: number; lowStock: number; oldStock: number; capacity: number };

export async function runAlertsScan(dbx: DbOrTx = db, now: Date = new Date()): Promise<AlertsScanResult> {
  const result: AlertsScanResult = { orgs: 0, lowStock: 0, oldStock: 0, capacity: 0 };
  const orgs = await dbx.select({ id: organization.id }).from(organization);
  for (const { id } of orgs) {
    try {
      const r = await scanOrgAlerts(dbx, id, now);
      result.lowStock += r.lowStock;
      result.oldStock += r.oldStock;
      result.capacity += r.capacity;
      result.orgs++;
    } catch (err) {
      // One broken org must not block the rest.
      console.error(`[alerts] scan failed for org ${id}`, err);
    }
  }
  return result;
}

export async function handleAlertsScan(jobs: Job<AlertsScanJob>[]): Promise<void> {
  if (!jobs.length) return;
  const r = await runAlertsScan();
  console.log(
    `[alerts] scanned ${r.orgs} org(s): +${r.lowStock} low-stock, +${r.oldStock} old-stock, +${r.capacity} capacity`,
  );
}
