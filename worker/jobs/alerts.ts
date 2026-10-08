/**
 * alerts.scan (cron ~15 min): per org, using organisation_settings thresholds
 * (defaults when an org has no settings row):
 *  - low stock: on-hand kg per commodity < low_stock_threshold_kg
 *  - old stock: lots received more than old_stock_days ago with stock on hand
 *  - capacity:  warehouse on-hand kg >= capacity_alert_percent % of capacity_kg
 * Inserts org-wide notifications (user_id null). Dedupe: skip when an UNREAD
 * notification with the same (org, type, link) already exists.
 * Straightforward queries on purpose — Wave 4 (P4-D) refines.
 */
import type { Job } from "pg-boss";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../src/db/client";
import { notifications, organisationSettings, organization } from "../../src/db/schema";
import { kgToGrams } from "../../src/lib/domain/units";
import type { AlertsScanJob } from "../../src/lib/jobs";
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

const DEFAULTS = { lowStockThresholdKg: "1000", oldStockDays: 90, capacityAlertPercent: 90 };

type OrgThresholds = {
  orgId: string;
  lowStockThresholdKg: string;
  oldStockDays: number;
  capacityAlertPercent: number;
};

async function loadOrgThresholds(dbx: DbOrTx): Promise<OrgThresholds[]> {
  const rows = await dbx
    .select({
      orgId: organization.id,
      low: organisationSettings.lowStockThresholdKg,
      days: organisationSettings.oldStockDays,
      pct: organisationSettings.capacityAlertPercent,
    })
    .from(organization)
    .leftJoin(organisationSettings, eq(organisationSettings.organisationId, organization.id));
  return rows.map((r) => ({
    orgId: r.orgId,
    lowStockThresholdKg: r.low ?? DEFAULTS.lowStockThresholdKg,
    oldStockDays: r.days ?? DEFAULTS.oldStockDays,
    capacityAlertPercent: r.pct ?? DEFAULTS.capacityAlertPercent,
  }));
}

async function scanLowStock(dbx: DbOrTx, t: OrgThresholds): Promise<number> {
  // Only commodities with movement history (never-stocked commodities don't alert).
  const res = await dbx.execute<{ commodity_id: string; name: string; on_hand_kg: string }>(sql`
    select c.id as commodity_id, c.name, coalesce(sum(m.kg), 0)::text as on_hand_kg
    from commodities c
    join lots l on l.commodity_id = c.id and l.organisation_id = c.organisation_id
    join stock_movements m on m.lot_id = l.id and m.organisation_id = c.organisation_id
    where c.organisation_id = ${t.orgId} and c.active
    group by c.id, c.name
    having coalesce(sum(m.kg), 0) < ${t.lowStockThresholdKg}::numeric
  `);
  let inserted = 0;
  for (const r of res.rows) {
    const ok = await notifyOnce(dbx, {
      orgId: t.orgId,
      type: "low_stock",
      title: `Low stock: ${r.name}`,
      body: `${pdfKg(kgToGrams(r.on_hand_kg))} kg on hand (threshold ${pdfKg(kgToGrams(t.lowStockThresholdKg))} kg).`,
      link: `/stock?commodity=${r.commodity_id}`,
    });
    if (ok) inserted++;
  }
  return inserted;
}

async function scanOldStock(dbx: DbOrTx, t: OrgThresholds, now: Date): Promise<number> {
  const res = await dbx.execute<{ lot_id: string; lot_number: string; on_hand_kg: string; age_days: string }>(sql`
    select l.id as lot_id, l.lot_number, sum(m.kg)::text as on_hand_kg,
           floor(extract(epoch from (${now.toISOString()}::timestamptz - l.received_at)) / 86400)::text as age_days
    from lots l
    join stock_movements m on m.lot_id = l.id and m.organisation_id = l.organisation_id
    where l.organisation_id = ${t.orgId}
      and l.received_at < ${now.toISOString()}::timestamptz - make_interval(days => ${t.oldStockDays}::int)
    group by l.id, l.lot_number, l.received_at
    having sum(m.kg) > 0
  `);
  let inserted = 0;
  for (const r of res.rows) {
    const ok = await notifyOnce(dbx, {
      orgId: t.orgId,
      type: "old_stock",
      title: `Old stock: lot ${r.lot_number}`,
      body: `${pdfKg(kgToGrams(r.on_hand_kg))} kg still on hand after ${r.age_days} days (limit ${t.oldStockDays}).`,
      link: `/stock/lots/${r.lot_id}`,
    });
    if (ok) inserted++;
  }
  return inserted;
}

async function scanCapacity(dbx: DbOrTx, t: OrgThresholds): Promise<number> {
  const res = await dbx.execute<{ warehouse_id: string; name: string; capacity_kg: string; on_hand_kg: string }>(sql`
    select w.id as warehouse_id, w.name, w.capacity_kg::text as capacity_kg,
           coalesce(sum(m.kg), 0)::text as on_hand_kg
    from warehouses w
    left join stock_movements m on m.warehouse_id = w.id and m.organisation_id = w.organisation_id
    where w.organisation_id = ${t.orgId} and w.active and w.capacity_kg > 0
    group by w.id, w.name, w.capacity_kg
    having coalesce(sum(m.kg), 0) >= w.capacity_kg * ${t.capacityAlertPercent}::numeric / 100
  `);
  let inserted = 0;
  for (const r of res.rows) {
    const onHand = kgToGrams(r.on_hand_kg);
    const cap = kgToGrams(r.capacity_kg);
    const pct = cap > 0 ? Math.round((onHand / cap) * 100) : 0;
    const ok = await notifyOnce(dbx, {
      orgId: t.orgId,
      type: "capacity",
      title: `Warehouse near capacity: ${r.name}`,
      body: `${pdfKg(onHand)} kg of ${pdfKg(cap)} kg (${pct}%, alert at ${t.capacityAlertPercent}%).`,
      link: `/stock?warehouse=${r.warehouse_id}`,
    });
    if (ok) inserted++;
  }
  return inserted;
}

export type AlertsScanResult = { orgs: number; lowStock: number; oldStock: number; capacity: number };

export async function runAlertsScan(dbx: DbOrTx = db, now: Date = new Date()): Promise<AlertsScanResult> {
  const result: AlertsScanResult = { orgs: 0, lowStock: 0, oldStock: 0, capacity: 0 };
  for (const t of await loadOrgThresholds(dbx)) {
    try {
      result.lowStock += await scanLowStock(dbx, t);
      result.oldStock += await scanOldStock(dbx, t, now);
      result.capacity += await scanCapacity(dbx, t);
      result.orgs++;
    } catch (err) {
      // One broken org must not block the rest.
      console.error(`[alerts] scan failed for org ${t.orgId}`, err);
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
