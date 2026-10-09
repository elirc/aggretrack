import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import type { OrgContext } from "@/lib/authz/context";
import { formatDocDate } from "@/lib/domain/format";
import { dispatchedCostKobo } from "@/lib/domain/margin";
import { gramsToKg, kgToGrams, parseLandedRate, type Grams, type Kobo } from "@/lib/domain/units";

import { execRows } from "./landedCost";
import { marginTotals } from "./margin";
import { openPayables, openReceivables } from "./reports";

/**
 * Dashboard aggregates (SPEC "Dashboard"). One call, a handful of set-based
 * queries (no N+1). Periods are Lagos calendar: week = Monday..today,
 * month = 1st..today. Money fields are null when ctx.restrictions.hidePrices.
 */

export type DashboardTop = { id: string; name: string; valueKobo: Kobo | null; kg: string };

export type DashboardData = {
  asOf: string;
  weekStart: string;
  monthStart: string;
  stock: { kg: string; valueKobo: Kobo | null; lots: number };
  purchases: { weekKobo: Kobo | null; monthKobo: Kobo | null; weekKg: string; monthKg: string };
  sales: { weekKobo: Kobo | null; monthKobo: Kobo | null; weekKg: string; monthKg: string };
  owedToSuppliersKobo: Kobo | null;
  owedByCustomersKobo: Kobo | null;
  grossMarginMonth: { revenueKobo: Kobo; costKobo: Kobo; marginKobo: Kobo; marginPercent: number } | null;
  /** Rolling window used for the top-5 lists. */
  topWindowDays: number;
  topSuppliers: DashboardTop[];
  topCustomers: DashboardTop[];
  pendingApprovals: { purchases: number; adjustments: number; total: number };
  unreadAlerts: number;
};

const DAY = 86_400_000;
const TOP_WINDOW_DAYS = 90;

function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Lagos-calendar period boundaries for `now`. */
export function lagosPeriods(now: Date = new Date()): { today: string; weekStart: string; monthStart: string } {
  const today = formatDocDate(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStart = shiftIso(today, -((dow + 6) % 7)); // Monday
  return { today, weekStart, monthStart: `${today.slice(0, 8)}01` };
}

export async function getDashboard(db: DbOrTx, ctx: OrgContext, now: Date = new Date()): Promise<DashboardData> {
  const { today, weekStart, monthStart } = lagosPeriods(now);
  const periodStart = weekStart < monthStart ? weekStart : monthStart;
  const topFrom = shiftIso(today, -(TOP_WINDOW_DAYS - 1));
  const hide = ctx.restrictions.hidePrices;
  const whIds = ctx.restrictions.warehouseIds;
  const whScope =
    whIds === null
      ? sql`TRUE`
      : whIds.length === 0
        ? sql`FALSE`
        : sql`m.warehouse_id IN (${sql.join(
            whIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;

  const [stockRows, buyRows, sellRows, topSup, topCus, counts, payables, receivables, margin] = await Promise.all([
    db.execute(sql`
      SELECT l.id, l.landed_cost_per_kg_kobo AS landed, sum(m.kg) AS kg
      FROM stock_movements m JOIN lots l ON l.id = m.lot_id
      WHERE m.organisation_id = ${ctx.orgId} AND ${whScope}
      GROUP BY l.id, l.landed_cost_per_kg_kobo
      HAVING sum(m.kg) <> 0
    `),
    db.execute(sql`
      SELECT
        coalesce(sum(p.total_amount_kobo) FILTER (WHERE p.purchase_date >= ${weekStart}::date), 0) AS week_kobo,
        coalesce(sum(p.total_amount_kobo) FILTER (WHERE p.purchase_date >= ${monthStart}::date), 0) AS month_kobo,
        coalesce(sum(pk.kg) FILTER (WHERE p.purchase_date >= ${weekStart}::date), 0) AS week_kg,
        coalesce(sum(pk.kg) FILTER (WHERE p.purchase_date >= ${monthStart}::date), 0) AS month_kg
      FROM purchases p
      LEFT JOIN (SELECT purchase_id, sum(net_kg) AS kg FROM purchase_lines
                 WHERE organisation_id = ${ctx.orgId} GROUP BY purchase_id) pk ON pk.purchase_id = p.id
      WHERE p.organisation_id = ${ctx.orgId} AND p.status <> 'cancelled'
        AND p.purchase_date BETWEEN ${periodStart}::date AND ${today}::date
    `),
    db.execute(sql`
      SELECT
        coalesce(sum(so.total_amount_kobo) FILTER (WHERE so.order_date >= ${weekStart}::date), 0) AS week_kobo,
        coalesce(sum(so.total_amount_kobo) FILTER (WHERE so.order_date >= ${monthStart}::date), 0) AS month_kobo,
        coalesce(sum(sk.kg) FILTER (WHERE so.order_date >= ${weekStart}::date), 0) AS week_kg,
        coalesce(sum(sk.kg) FILTER (WHERE so.order_date >= ${monthStart}::date), 0) AS month_kg
      FROM sales_orders so
      LEFT JOIN (SELECT sales_order_id, sum(kg) AS kg FROM sales_lines
                 WHERE organisation_id = ${ctx.orgId} GROUP BY sales_order_id) sk ON sk.sales_order_id = so.id
      WHERE so.organisation_id = ${ctx.orgId} AND so.status <> 'cancelled'
        AND so.order_date BETWEEN ${periodStart}::date AND ${today}::date
    `),
    db.execute(sql`
      SELECT s.id, s.name, sum(p.total_amount_kobo) AS value,
        coalesce(sum(pk.kg), 0) AS kg
      FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN (SELECT purchase_id, sum(net_kg) AS kg FROM purchase_lines
                 WHERE organisation_id = ${ctx.orgId} GROUP BY purchase_id) pk ON pk.purchase_id = p.id
      WHERE p.organisation_id = ${ctx.orgId} AND p.status <> 'cancelled'
        AND p.purchase_date BETWEEN ${topFrom}::date AND ${today}::date
      GROUP BY s.id, s.name
      ORDER BY value DESC, s.name
      LIMIT 5
    `),
    db.execute(sql`
      SELECT cu.id, cu.name, sum(so.total_amount_kobo) AS value,
        coalesce(sum(sk.kg), 0) AS kg
      FROM sales_orders so JOIN customers cu ON cu.id = so.customer_id
      LEFT JOIN (SELECT sales_order_id, sum(kg) AS kg FROM sales_lines
                 WHERE organisation_id = ${ctx.orgId} GROUP BY sales_order_id) sk ON sk.sales_order_id = so.id
      WHERE so.organisation_id = ${ctx.orgId} AND so.status <> 'cancelled'
        AND so.order_date BETWEEN ${topFrom}::date AND ${today}::date
      GROUP BY cu.id, cu.name
      ORDER BY value DESC, cu.name
      LIMIT 5
    `),
    db.execute(sql`
      SELECT
        (SELECT count(*) FROM purchases WHERE organisation_id = ${ctx.orgId} AND status = 'pending_approval') AS purchases,
        (SELECT count(*) FROM adjustments WHERE organisation_id = ${ctx.orgId} AND status = 'pending_approval') AS adjustments,
        (SELECT count(*) FROM notifications WHERE organisation_id = ${ctx.orgId} AND read_at IS NULL
           AND (user_id IS NULL OR user_id = ${ctx.userId})) AS unread
    `),
    hide ? Promise.resolve([]) : openPayables(db, ctx, today),
    hide ? Promise.resolve([]) : openReceivables(db, ctx, today),
    hide ? Promise.resolve(null) : marginTotals(db, ctx, { from: monthStart, to: today }),
  ]);

  let stockG: Grams = 0;
  let stockValue: Kobo = 0;
  const stock = execRows<{ id: string; landed: string; kg: string }>(stockRows);
  for (const r of stock) {
    const grams = kgToGrams(String(r.kg));
    stockG += grams;
    if (grams > 0) stockValue += dispatchedCostKobo(grams, parseLandedRate(r.landed));
  }

  const [buy] = execRows<Record<string, string>>(buyRows);
  const [sell] = execRows<Record<string, string>>(sellRows);
  const [c] = execRows<Record<string, string>>(counts);
  const money = (v: unknown): Kobo | null => (hide ? null : Number(v ?? 0));
  const kg = (v: unknown) => gramsToKg(kgToGrams(String(v ?? "0")));
  const top = (rows: unknown): DashboardTop[] =>
    execRows<Record<string, string>>(rows).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      valueKobo: money(r.value),
      kg: kg(r.kg),
    }));

  const purchasesPending = Number(c?.purchases ?? 0);
  const adjustmentsPending = Number(c?.adjustments ?? 0);

  return {
    asOf: today,
    weekStart,
    monthStart,
    stock: { kg: gramsToKg(stockG), valueKobo: hide ? null : stockValue, lots: stock.length },
    purchases: {
      weekKobo: money(buy?.week_kobo),
      monthKobo: money(buy?.month_kobo),
      weekKg: kg(buy?.week_kg),
      monthKg: kg(buy?.month_kg),
    },
    sales: {
      weekKobo: money(sell?.week_kobo),
      monthKobo: money(sell?.month_kobo),
      weekKg: kg(sell?.week_kg),
      monthKg: kg(sell?.month_kg),
    },
    owedToSuppliersKobo: hide ? null : payables.reduce((s, i) => s + i.outstandingKobo, 0),
    owedByCustomersKobo: hide ? null : receivables.reduce((s, i) => s + i.outstandingKobo, 0),
    grossMarginMonth: margin
      ? {
          revenueKobo: margin.revenueKobo,
          costKobo: margin.costKobo,
          marginKobo: margin.marginKobo,
          marginPercent: Math.round(margin.marginPercent * 100) / 100,
        }
      : null,
    topWindowDays: TOP_WINDOW_DAYS,
    topSuppliers: top(topSup),
    topCustomers: top(topCus),
    pendingApprovals: {
      purchases: purchasesPending,
      adjustments: adjustmentsPending,
      total: purchasesPending + adjustmentsPending,
    },
    unreadAlerts: Number(c?.unread ?? 0),
  };
}
