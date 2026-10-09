import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { commodities, lots, organisationSettings, stockMovements, warehouses } from "@/db/schema";
import { ageInDays } from "@/lib/domain/ageing";
import { gramsToKg, kgToGrams, type Grams } from "@/lib/domain/units";

/**
 * Alert scan rules (P2-B) — pure-ish read queries used by the worker's alert
 * job. They take an organisation id (the worker has no user context) plus the
 * org's alert settings, and return typed rows. They NEVER write
 * notifications; the worker/notification service owns that.
 */

export type AlertSettings = {
  lowStockThresholdKg: string;
  oldStockDays: number;
  capacityAlertPercent: number;
};

export async function loadAlertSettings(db: DbOrTx, orgId: string): Promise<AlertSettings> {
  const [row] = await db
    .select({
      lowStockThresholdKg: organisationSettings.lowStockThresholdKg,
      oldStockDays: organisationSettings.oldStockDays,
      capacityAlertPercent: organisationSettings.capacityAlertPercent,
    })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, orgId))
    .limit(1);
  return row ?? { lowStockThresholdKg: "1000", oldStockDays: 90, capacityAlertPercent: 90 };
}

export type LowStockRow = {
  commodityId: string;
  commodityName: string;
  onHandKg: string;
  onHandGrams: Grams;
  thresholdKg: string;
};

/** Active commodities whose org-wide on hand is below low_stock_threshold_kg (zero stock included). */
export async function lowStock(db: DbOrTx, orgId: string, settings: AlertSettings): Promise<LowStockRow[]> {
  const thresholdG = kgToGrams(settings.lowStockThresholdKg);
  const onHand = sql<string>`coalesce((
    select sum(sm.kg) from stock_movements sm
    join lots l on l.id = sm.lot_id
    where sm.organisation_id = ${orgId} and l.commodity_id = "commodities"."id"
  ), 0)`;
  const rows = await db
    .select({ commodityId: commodities.id, commodityName: commodities.name, kg: onHand })
    .from(commodities)
    .where(and(eq(commodities.organisationId, orgId), eq(commodities.active, true)))
    .orderBy(asc(commodities.name));
  return rows
    .map((r) => ({ ...r, g: kgToGrams(r.kg) }))
    .filter((r) => r.g < thresholdG)
    .map((r) => ({
      commodityId: r.commodityId,
      commodityName: r.commodityName,
      onHandKg: gramsToKg(r.g),
      onHandGrams: r.g,
      thresholdKg: gramsToKg(thresholdG),
    }));
}

export type OldStockRow = {
  lotId: string;
  lotNumber: string;
  commodityName: string;
  warehouseId: string;
  warehouseName: string;
  receivedAt: Date;
  ageDays: number;
  onHandKg: string;
  onHandGrams: Grams;
};

/** Lot × warehouse balances > 0 for lots received more than old_stock_days ago. */
export async function oldStock(
  db: DbOrTx,
  orgId: string,
  settings: AlertSettings,
  asOf: Date = new Date(),
): Promise<OldStockRow[]> {
  const cutoff = new Date(asOf.getTime() - settings.oldStockDays * 86_400_000);
  const rows = await db
    .select({
      lotId: lots.id,
      lotNumber: lots.lotNumber,
      commodityName: commodities.name,
      warehouseId: warehouses.id,
      warehouseName: warehouses.name,
      receivedAt: lots.receivedAt,
      kg: sql<string>`sum(${stockMovements.kg})`,
    })
    .from(stockMovements)
    .innerJoin(lots, eq(lots.id, stockMovements.lotId))
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .where(and(eq(stockMovements.organisationId, orgId), lt(lots.receivedAt, cutoff)))
    .groupBy(lots.id, lots.lotNumber, commodities.name, warehouses.id, warehouses.name, lots.receivedAt)
    .having(sql`sum(${stockMovements.kg}) > 0`)
    .orderBy(asc(lots.receivedAt), asc(lots.id));
  return rows
    .map((r) => {
      const g = kgToGrams(r.kg);
      return {
        lotId: r.lotId,
        lotNumber: r.lotNumber,
        commodityName: r.commodityName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        receivedAt: r.receivedAt,
        ageDays: ageInDays(asOf, r.receivedAt),
        onHandKg: gramsToKg(g),
        onHandGrams: g,
      };
    })
    .filter((r) => r.ageDays > settings.oldStockDays);
}

export type NearCapacityRow = {
  warehouseId: string;
  warehouseName: string;
  capacityKg: string;
  onHandKg: string;
  onHandGrams: Grams;
  usedPercent: number;
};

/** Active warehouses with a capacity whose on hand ≥ capacity_alert_percent of capacity_kg. */
export async function nearCapacity(
  db: DbOrTx,
  orgId: string,
  settings: AlertSettings,
): Promise<NearCapacityRow[]> {
  const onHand = sql<string>`coalesce((
    select sum(sm.kg) from stock_movements sm
    where sm.organisation_id = ${orgId} and sm.warehouse_id = "warehouses"."id"
  ), 0)`;
  const rows = await db
    .select({ id: warehouses.id, name: warehouses.name, capacityKg: warehouses.capacityKg, kg: onHand })
    .from(warehouses)
    .where(and(eq(warehouses.organisationId, orgId), eq(warehouses.active, true), isNotNull(warehouses.capacityKg)))
    .orderBy(asc(warehouses.name));
  const out: NearCapacityRow[] = [];
  for (const r of rows) {
    const capG = kgToGrams(r.capacityKg!);
    if (capG <= 0) continue;
    const g = kgToGrams(r.kg);
    // Integer comparison: g / cap ≥ pct / 100  ⇔  g × 100 ≥ pct × cap.
    if (g * 100 < settings.capacityAlertPercent * capG) continue;
    out.push({
      warehouseId: r.id,
      warehouseName: r.name,
      capacityKg: gramsToKg(capG),
      onHandKg: gramsToKg(g),
      onHandGrams: g,
      usedPercent: Math.round((g * 10_000) / capG) / 100,
    });
  }
  return out;
}

/** Convenience: run all three scans for one organisation. */
export async function scanAlerts(
  db: DbOrTx,
  orgId: string,
  asOf: Date = new Date(),
): Promise<{ lowStock: LowStockRow[]; oldStock: OldStockRow[]; nearCapacity: NearCapacityRow[] }> {
  const settings = await loadAlertSettings(db, orgId);
  return {
    lowStock: await lowStock(db, orgId, settings),
    oldStock: await oldStock(db, orgId, settings, asOf),
    nearCapacity: await nearCapacity(db, orgId, settings),
  };
}
