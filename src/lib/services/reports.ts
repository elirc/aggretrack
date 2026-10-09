import { sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import type { OrgContext } from "@/lib/authz/context";
import { AGE_BANDS, ageInDays, bucketByAge, type AgeBand } from "@/lib/domain/ageing";
import { dispatchedCostKobo } from "@/lib/domain/margin";
import { gramsToKg, kgToGrams, parseLandedRate, type Grams, type Kobo } from "@/lib/domain/units";
import type {
  MarginReportInput,
  PayablesAgeingReportInput,
  PurchasesReportInput,
  ReceivablesAgeingReportInput,
  ReportKey,
  RunReportInput,
  SalesByCustomerReportInput,
  ShrinkageReportInput,
  StockMovementsReportInput,
  StockPositionReportInput,
  SupplierPerformanceReportInput,
  TripCostsReportInput,
} from "@/lib/validation/logistics";

import { execRows } from "./landedCost";
import {
  marginByCommodity,
  marginByCustomer,
  marginByLot,
  marginBySale,
  type CommodityMarginRow,
  type CustomerMarginRow,
  type LotMarginRow,
  type SaleMarginRow,
} from "./margin";

/**
 * The 10 report queries (SPEC "Dashboard and reports"). Each returns a
 * ReportResult: column metadata (label + value type, for table render AND the
 * Excel/PDF exporters) plus typed rows and an optional totals row.
 *
 * Conventions: kg values are numeric(12,3) strings ("1234.500"); money is
 * integer kobo; rates are kobo/kg numbers (2 dp for averages) or numeric(14,4)
 * strings (landed); percents are numbers rounded to 2 dp. Date params are
 * Lagos calendar dates (yyyy-mm-dd, inclusive); timestamp columns are compared
 * via (ts AT TIME ZONE 'Africa/Lagos')::date. Every query is org-scoped; stock
 * reports also honour warehouse restrictions; money columns are stripped when
 * ctx.restrictions.hidePrices.
 */

export type ColumnType = "text" | "date" | "datetime" | "kg" | "kobo" | "rate" | "percent" | "int";

export type ReportColumn<R> = {
  key: Extract<keyof R, string>;
  label: string;
  type: ColumnType;
};

export type ReportResult<R> = {
  key: ReportKey;
  title: string;
  /** Human summary of the parameters, e.g. "2026-09-01 → 2026-09-30". */
  subtitle: string;
  columns: ReportColumn<R>[];
  rows: R[];
  totals: Partial<R> | null;
};

const MONEY_TYPES: ReadonlySet<ColumnType> = new Set(["kobo", "rate"]);

function finalize<R>(ctx: OrgContext, r: ReportResult<R>): ReportResult<R> {
  if (!ctx.restrictions.hidePrices) return r;
  const moneyKeys = r.columns.filter((c) => MONEY_TYPES.has(c.type)).map((c) => c.key as string);
  const strip = (row: Partial<R>) => {
    const copy = { ...row } as Record<string, unknown>;
    for (const k of moneyKeys) delete copy[k];
    return copy as Partial<R>;
  };
  return {
    ...r,
    columns: r.columns.filter((c) => !MONEY_TYPES.has(c.type)),
    rows: r.rows.map((row) => strip(row) as R),
    totals: r.totals ? strip(r.totals) : null,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const lagosDate = (col: SQL) => sql`(${col} AT TIME ZONE 'Africa/Lagos')::date`;
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const g = (v: unknown): Grams => (v === null || v === undefined ? 0 : kgToGrams(String(v)));
const round2 = (x: number) => Math.round(x * 100) / 100;
/** kobo per kg from totals (2 dp); 0 when no weight. */
const perKg = (kobo: Kobo, grams: Grams) => (grams === 0 ? 0 : round2((kobo * 1000) / grams));
const pct = (part: number, whole: number) => (whole === 0 ? 0 : round2((part / whole) * 100));

function sumKey<R>(rows: R[], key: keyof R, kind: "num" | "kg"): number | string {
  if (kind === "kg") {
    let t = 0;
    for (const r of rows) t += kgToGrams(String(r[key] ?? "0"));
    return gramsToKg(t);
  }
  let t = 0;
  for (const r of rows) t += Number(r[key] ?? 0);
  return t;
}

function totalsOf<R>(rows: R[], labelKey: keyof R, nums: (keyof R)[], kgs: (keyof R)[]): Partial<R> | null {
  if (rows.length === 0) return null;
  const out: Record<string, unknown> = { [labelKey as string]: "Total" };
  for (const k of nums) out[k as string] = sumKey(rows, k, "num");
  for (const k of kgs) out[k as string] = sumKey(rows, k, "kg");
  return out as Partial<R>;
}

function warehouseScope(ctx: OrgContext, col: SQL): SQL {
  const ids = ctx.restrictions.warehouseIds;
  if (ids === null) return sql`TRUE`;
  if (ids.length === 0) return sql`FALSE`;
  return sql`${col} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

const opt = (cond: unknown, frag: SQL): SQL => (cond ? frag : sql``);

// ── 1. Purchases by supplier / commodity / period ────────────────────────────

export type PurchasesReportRow = {
  groupKey: string;
  groupLabel: string;
  purchases: number;
  lines: number;
  bags: number;
  grossKg: string;
  netKg: string;
  amountKobo: Kobo;
  avgPricePerKgKobo: number;
};

export async function purchasesReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: PurchasesReportInput,
): Promise<ReportResult<PurchasesReportRow>> {
  const grp: Record<PurchasesReportInput["groupBy"], { key: SQL; label: SQL; order: SQL }> = {
    supplier: { key: sql`s.id::text`, label: sql`s.name`, order: sql`amount DESC, label` },
    commodity: { key: sql`c.id::text`, label: sql`c.name`, order: sql`amount DESC, label` },
    day: { key: sql`p.purchase_date::text`, label: sql`p.purchase_date::text`, order: sql`key` },
    week: {
      key: sql`date_trunc('week', p.purchase_date)::date::text`,
      label: sql`'Week of ' || date_trunc('week', p.purchase_date)::date::text`,
      order: sql`key`,
    },
    month: {
      key: sql`to_char(p.purchase_date, 'YYYY-MM')`,
      label: sql`to_char(p.purchase_date, 'YYYY-MM')`,
      order: sql`key`,
    },
  };
  const G = grp[p.groupBy];
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT ${G.key} AS key, ${G.label} AS label,
        count(DISTINCT p.id) AS purchases, count(pl.id) AS lines,
        coalesce(sum(pl.bags), 0) AS bags,
        coalesce(sum(pl.gross_kg), 0) AS gross_kg, coalesce(sum(pl.net_kg), 0) AS net_kg,
        coalesce(sum(pl.amount_kobo), 0) AS amount
      FROM purchases p
      JOIN purchase_lines pl ON pl.purchase_id = p.id
      JOIN suppliers s ON s.id = p.supplier_id
      JOIN commodities c ON c.id = pl.commodity_id
      WHERE p.organisation_id = ${ctx.orgId}
        AND p.status <> 'cancelled'
        AND p.purchase_date BETWEEN ${p.from}::date AND ${p.to}::date
        ${opt(p.supplierId, sql`AND p.supplier_id = ${p.supplierId}::uuid`)}
        ${opt(p.commodityId, sql`AND pl.commodity_id = ${p.commodityId}::uuid`)}
        ${opt(p.buyingPointId, sql`AND p.buying_point_id = ${p.buyingPointId}::uuid`)}
      GROUP BY 1, 2
      ORDER BY ${G.order}
    `),
  );
  const out: PurchasesReportRow[] = rows.map((r) => {
    const net = g(r.net_kg);
    const amount = n(r.amount);
    return {
      groupKey: String(r.key),
      groupLabel: String(r.label),
      purchases: n(r.purchases),
      lines: n(r.lines),
      bags: n(r.bags),
      grossKg: gramsToKg(g(r.gross_kg)),
      netKg: gramsToKg(net),
      amountKobo: amount,
      avgPricePerKgKobo: perKg(amount, net),
    };
  });
  const totals = totalsOf(out, "groupLabel", ["purchases", "lines", "bags", "amountKobo"], ["grossKg", "netKg"]);
  if (totals) totals.avgPricePerKgKobo = perKg(Number(totals.amountKobo), kgToGrams(String(totals.netKg)));
  const groupLabel = { supplier: "Supplier", commodity: "Commodity", day: "Day", week: "Week", month: "Month" }[p.groupBy];
  return finalize(ctx, {
    key: "purchases",
    title: `Purchases by ${groupLabel.toLowerCase()}`,
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "groupLabel", label: groupLabel, type: "text" },
      { key: "purchases", label: "Purchases", type: "int" },
      { key: "lines", label: "Lines", type: "int" },
      { key: "bags", label: "Bags", type: "int" },
      { key: "grossKg", label: "Gross kg", type: "kg" },
      { key: "netKg", label: "Net kg", type: "kg" },
      { key: "amountKobo", label: "Amount", type: "kobo" },
      { key: "avgPricePerKgKobo", label: "Avg price / kg", type: "rate" },
    ],
    rows: out,
    totals,
  });
}

// ── 2. Stock position AS AT a date ───────────────────────────────────────────

export type StockPositionRow = {
  lotId: string;
  lotNumber: string;
  commodityName: string;
  gradeName: string;
  warehouseId: string;
  warehouseName: string;
  receivedAt: Date;
  ageDays: number;
  kg: string;
  bags: number;
  landedCostPerKgKobo: string;
  valueKobo: Kobo;
};

/**
 * Σ movements with occurred_at (Lagos date) ≤ asAt per lot × warehouse — a true
 * historical position, not the current snapshot. Value uses the lot's CURRENT
 * landed rate (late-cost rule).
 */
export async function stockPositionReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: StockPositionReportInput,
): Promise<ReportResult<StockPositionRow>> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT m.lot_id, m.warehouse_id, l.lot_number, c.name AS commodity, gr.name AS grade, w.name AS warehouse,
        l.received_at, l.landed_cost_per_kg_kobo AS landed,
        sum(m.kg) AS kg, sum(m.bags) AS bags
      FROM stock_movements m
      JOIN lots l ON l.id = m.lot_id
      JOIN commodities c ON c.id = l.commodity_id
      JOIN grades gr ON gr.id = l.grade_id
      JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.organisation_id = ${ctx.orgId}
        AND ${lagosDate(sql`m.occurred_at`)} <= ${p.asAt}::date
        AND ${warehouseScope(ctx, sql`m.warehouse_id`)}
        ${opt(p.warehouseId, sql`AND m.warehouse_id = ${p.warehouseId}::uuid`)}
        ${opt(p.commodityId, sql`AND l.commodity_id = ${p.commodityId}::uuid`)}
        ${opt(p.gradeId, sql`AND l.grade_id = ${p.gradeId}::uuid`)}
      GROUP BY m.lot_id, m.warehouse_id, l.lot_number, c.name, gr.name, w.name, l.received_at, l.landed_cost_per_kg_kobo
      HAVING sum(m.kg) <> 0
      ORDER BY c.name, gr.name, w.name, l.received_at, l.lot_number
    `),
  );
  const asAtDate = new Date(`${p.asAt}T12:00:00Z`);
  const out: StockPositionRow[] = rows.map((r) => {
    const grams = g(r.kg);
    const landed = String(r.landed);
    const receivedAt = new Date(r.received_at as string | Date);
    return {
      lotId: String(r.lot_id),
      lotNumber: String(r.lot_number),
      commodityName: String(r.commodity),
      gradeName: String(r.grade),
      warehouseId: String(r.warehouse_id),
      warehouseName: String(r.warehouse),
      receivedAt,
      ageDays: ageInDays(asAtDate, receivedAt),
      kg: gramsToKg(grams),
      bags: n(r.bags),
      landedCostPerKgKobo: landed,
      valueKobo: grams > 0 ? dispatchedCostKobo(grams, parseLandedRate(landed)) : 0,
    };
  });
  return finalize(ctx, {
    key: "stock-position",
    title: "Stock position",
    subtitle: `As at ${p.asAt}`,
    columns: [
      { key: "commodityName", label: "Commodity", type: "text" },
      { key: "gradeName", label: "Grade", type: "text" },
      { key: "warehouseName", label: "Warehouse", type: "text" },
      { key: "lotNumber", label: "Lot", type: "text" },
      { key: "receivedAt", label: "Received", type: "datetime" },
      { key: "ageDays", label: "Age (days)", type: "int" },
      { key: "kg", label: "Kg", type: "kg" },
      { key: "bags", label: "Bags", type: "int" },
      { key: "landedCostPerKgKobo", label: "Landed / kg", type: "rate" },
      { key: "valueKobo", label: "Value", type: "kobo" },
    ],
    rows: out,
    totals: totalsOf(out, "commodityName", ["bags", "valueKobo"], ["kg"]),
  });
}

// ── 3. Stock movements ───────────────────────────────────────────────────────

export type StockMovementRow = {
  movementId: string;
  occurredAt: Date;
  type: string;
  lotId: string;
  lotNumber: string;
  commodityName: string;
  gradeName: string;
  warehouseName: string;
  binName: string | null;
  kg: string;
  bags: number;
  refType: string | null;
  refId: string | null;
  userName: string | null;
};

export async function stockMovementsReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: StockMovementsReportInput,
): Promise<ReportResult<StockMovementRow>> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT m.id, m.occurred_at, m.type, m.lot_id, l.lot_number, c.name AS commodity, gr.name AS grade,
        w.name AS warehouse, b.name AS bin, m.kg, m.bags, m.ref_type, m.ref_id, u.name AS user_name
      FROM stock_movements m
      JOIN lots l ON l.id = m.lot_id
      JOIN commodities c ON c.id = l.commodity_id
      JOIN grades gr ON gr.id = l.grade_id
      JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN bins b ON b.id = m.bin_id
      LEFT JOIN "user" u ON u.id = m.created_by
      WHERE m.organisation_id = ${ctx.orgId}
        AND ${lagosDate(sql`m.occurred_at`)} BETWEEN ${p.from}::date AND ${p.to}::date
        AND ${warehouseScope(ctx, sql`m.warehouse_id`)}
        ${opt(p.warehouseId, sql`AND m.warehouse_id = ${p.warehouseId}::uuid`)}
        ${opt(p.commodityId, sql`AND l.commodity_id = ${p.commodityId}::uuid`)}
        ${opt(p.lotId, sql`AND m.lot_id = ${p.lotId}::uuid`)}
        ${opt(p.type, sql`AND m.type = ${p.type}`)}
      ORDER BY m.occurred_at, m.created_at
      LIMIT ${p.limit}
    `),
  );
  const out: StockMovementRow[] = rows.map((r) => ({
    movementId: String(r.id),
    occurredAt: new Date(r.occurred_at as string | Date),
    type: String(r.type),
    lotId: String(r.lot_id),
    lotNumber: String(r.lot_number),
    commodityName: String(r.commodity),
    gradeName: String(r.grade),
    warehouseName: String(r.warehouse),
    binName: (r.bin as string | null) ?? null,
    kg: gramsToKg(g(r.kg)),
    bags: n(r.bags),
    refType: (r.ref_type as string | null) ?? null,
    refId: (r.ref_id as string | null) ?? null,
    userName: (r.user_name as string | null) ?? null,
  }));
  return finalize(ctx, {
    key: "stock-movements",
    title: "Stock movements",
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "occurredAt", label: "When", type: "datetime" },
      { key: "type", label: "Type", type: "text" },
      { key: "lotNumber", label: "Lot", type: "text" },
      { key: "commodityName", label: "Commodity", type: "text" },
      { key: "gradeName", label: "Grade", type: "text" },
      { key: "warehouseName", label: "Warehouse", type: "text" },
      { key: "binName", label: "Bin", type: "text" },
      { key: "kg", label: "Kg", type: "kg" },
      { key: "bags", label: "Bags", type: "int" },
      { key: "refType", label: "Ref", type: "text" },
      { key: "userName", label: "By", type: "text" },
    ],
    rows: out,
    totals: null,
  });
}

// ── 4. Sales by customer ─────────────────────────────────────────────────────

export type SalesByCustomerRow = {
  customerId: string;
  customerName: string;
  orders: number;
  orderedKg: string;
  orderValueKobo: Kobo;
  dispatchedKg: string;
  invoicedKobo: Kobo | null;
};

/** Orders (order_date in range, not cancelled); dispatched kg of those orders; invoiced = non-void invoices of those orders (null under a commodity filter). */
export async function salesByCustomerReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: SalesByCustomerReportInput,
): Promise<ReportResult<SalesByCustomerRow>> {
  const orderScope = sql`
    so.organisation_id = ${ctx.orgId}
    AND so.status <> 'cancelled'
    AND so.order_date BETWEEN ${p.from}::date AND ${p.to}::date
    ${opt(p.customerId, sql`AND so.customer_id = ${p.customerId}::uuid`)}
  `;
  const commodity = opt(p.commodityId, sql`AND sl.commodity_id = ${p.commodityId}::uuid`);
  const ordered = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT so.customer_id, cu.name, count(DISTINCT so.id) AS orders,
        coalesce(sum(sl.kg), 0) AS kg, coalesce(sum(sl.amount_kobo), 0) AS amount
      FROM sales_orders so
      JOIN sales_lines sl ON sl.sales_order_id = so.id
      JOIN customers cu ON cu.id = so.customer_id
      WHERE ${orderScope} ${commodity}
      GROUP BY so.customer_id, cu.name
    `),
  );
  const dispatched = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT so.customer_id, coalesce(sum(dl.kg), 0) AS kg
      FROM dispatch_lines dl
      JOIN lot_allocations la ON la.id = dl.lot_allocation_id
      JOIN sales_lines sl ON sl.id = la.sales_line_id
      JOIN sales_orders so ON so.id = sl.sales_order_id
      WHERE ${orderScope} ${commodity}
      GROUP BY so.customer_id
    `),
  );
  const invoiced = p.commodityId
    ? []
    : execRows<Record<string, unknown>>(
        await db.execute(sql`
          SELECT so.customer_id, coalesce(sum(i.total_kobo), 0) AS total
          FROM invoices i
          JOIN sales_orders so ON so.id = i.sales_order_id
          WHERE ${orderScope} AND i.status <> 'void'
          GROUP BY so.customer_id
        `),
      );
  const dMap = new Map(dispatched.map((r) => [String(r.customer_id), g(r.kg)]));
  const iMap = new Map(invoiced.map((r) => [String(r.customer_id), n(r.total)]));
  const out: SalesByCustomerRow[] = ordered
    .map((r) => {
      const id = String(r.customer_id);
      return {
        customerId: id,
        customerName: String(r.name),
        orders: n(r.orders),
        orderedKg: gramsToKg(g(r.kg)),
        orderValueKobo: n(r.amount),
        dispatchedKg: gramsToKg(dMap.get(id) ?? 0),
        invoicedKobo: p.commodityId ? null : (iMap.get(id) ?? 0),
      };
    })
    .sort((a, b) => b.orderValueKobo - a.orderValueKobo);
  return finalize(ctx, {
    key: "sales-by-customer",
    title: "Sales by customer",
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "customerName", label: "Customer", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "orderedKg", label: "Ordered kg", type: "kg" },
      { key: "orderValueKobo", label: "Order value", type: "kobo" },
      { key: "dispatchedKg", label: "Dispatched kg", type: "kg" },
      { key: "invoicedKobo", label: "Invoiced", type: "kobo" },
    ],
    rows: out,
    totals: totalsOf(
      out,
      "customerName",
      p.commodityId ? ["orders", "orderValueKobo"] : ["orders", "orderValueKobo", "invoicedKobo"],
      ["orderedKg", "dispatchedKg"],
    ),
  });
}

// ── 5. Margin (reuses the margin service) ────────────────────────────────────

const MARGIN_COLS = [
  { key: "dispatchedKg", label: "Dispatched kg", type: "kg" },
  { key: "revenueKobo", label: "Revenue", type: "kobo" },
  { key: "costKobo", label: "Landed cost", type: "kobo" },
  { key: "expensesKobo", label: "Expenses", type: "kobo" },
  { key: "marginKobo", label: "Margin", type: "kobo" },
  { key: "marginPercent", label: "Margin %", type: "percent" },
] as const;

export type MarginReportResult =
  | ReportResult<LotMarginRow>
  | ReportResult<SaleMarginRow>
  | ReportResult<CustomerMarginRow>
  | ReportResult<CommodityMarginRow>;

function marginTotals<R extends { revenueKobo: number; marginKobo: number }>(
  rows: R[],
  labelKey: keyof R,
): Partial<R> | null {
  const t = totalsOf(rows, labelKey, ["revenueKobo", "costKobo", "expensesKobo", "marginKobo"] as (keyof R)[], [
    "dispatchedKg",
  ] as (keyof R)[]);
  if (t) (t as Record<string, unknown>).marginPercent = pct(Number(t.marginKobo), Number(t.revenueKobo));
  return t;
}

export async function marginReport(db: DbOrTx, ctx: OrgContext, p: MarginReportInput): Promise<MarginReportResult> {
  const f = { from: p.from, to: p.to, customerId: p.customerId, commodityId: p.commodityId };
  const subtitle = `${p.from} → ${p.to} (by dispatch date; landed cost at current rates)`;
  const round = <R extends { marginPercent: number }>(rows: R[]) =>
    rows.map((r) => ({ ...r, marginPercent: round2(r.marginPercent) }));
  switch (p.by) {
    case "lot": {
      const rows = round(await marginByLot(db, ctx, f));
      return finalize(ctx, {
        key: "margin",
        title: "Margin by lot",
        subtitle,
        columns: [
          { key: "lotNumber", label: "Lot", type: "text" },
          { key: "commodityName", label: "Commodity", type: "text" },
          { key: "gradeName", label: "Grade", type: "text" },
          { key: "supplierName", label: "Supplier", type: "text" },
          { key: "landedCostPerKgKobo", label: "Landed / kg", type: "rate" },
          ...MARGIN_COLS,
        ],
        rows,
        totals: marginTotals(rows, "lotNumber"),
      });
    }
    case "sale": {
      const rows = round(await marginBySale(db, ctx, f));
      return finalize(ctx, {
        key: "margin",
        title: "Margin by sale",
        subtitle,
        columns: [
          { key: "orderNumber", label: "Sale", type: "text" },
          { key: "orderDate", label: "Date", type: "date" },
          { key: "customerName", label: "Customer", type: "text" },
          ...MARGIN_COLS,
        ],
        rows,
        totals: marginTotals(rows, "orderNumber"),
      });
    }
    case "customer": {
      const rows = round(await marginByCustomer(db, ctx, f));
      return finalize(ctx, {
        key: "margin",
        title: "Margin by customer",
        subtitle,
        columns: [
          { key: "customerName", label: "Customer", type: "text" },
          { key: "sales", label: "Sales", type: "int" },
          ...MARGIN_COLS,
        ],
        rows,
        totals: marginTotals(rows, "customerName"),
      });
    }
    case "commodity": {
      const rows = round(await marginByCommodity(db, ctx, f));
      return finalize(ctx, {
        key: "margin",
        title: "Margin by commodity",
        subtitle,
        columns: [
          { key: "commodityName", label: "Commodity", type: "text" },
          { key: "sales", label: "Sales", type: "int" },
          ...MARGIN_COLS,
        ],
        rows,
        totals: marginTotals(rows, "commodityName"),
      });
    }
  }
}

// ── 6/7. Ageing (payables + receivables) ─────────────────────────────────────

export type OpenItem = { id: string; partyId: string; partyName: string; date: string; outstandingKobo: Kobo };

/**
 * Open payables as at a Lagos date (DOMAIN-ENGINE §10): received purchases
 * (purchase_date and receipt ≤ asAt) with outstanding = total − payment
 * allocations (payment_date ≤ asAt) − advance offsets (created ≤ asAt) > 0.
 * Origin = purchase_date.
 */
export async function openPayables(
  db: DbOrTx,
  ctx: OrgContext,
  asAt: string,
  supplierId?: string,
): Promise<OpenItem[]> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT * FROM (
        SELECT p.id, p.supplier_id AS party_id, s.name AS party_name, p.purchase_date::text AS date,
          p.total_amount_kobo
          - coalesce((SELECT sum(a.amount_kobo) FROM supplier_payment_allocations a
                      JOIN supplier_payments sp ON sp.id = a.payment_id
                      WHERE a.purchase_id = p.id AND sp.payment_date <= ${asAt}::date), 0)
          - coalesce((SELECT sum(o.amount_kobo) FROM supplier_advance_offsets o
                      WHERE o.purchase_id = p.id AND ${lagosDate(sql`o.created_at`)} <= ${asAt}::date), 0)
          AS outstanding
        FROM purchases p
        JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.organisation_id = ${ctx.orgId}
          AND p.status = 'received'
          AND p.purchase_date <= ${asAt}::date
          AND (p.received_at IS NULL OR ${lagosDate(sql`p.received_at`)} <= ${asAt}::date)
          ${opt(supplierId, sql`AND p.supplier_id = ${supplierId}::uuid`)}
      ) x WHERE outstanding > 0
      ORDER BY date, id
    `),
  );
  return rows.map((r) => ({
    id: String(r.id),
    partyId: String(r.party_id),
    partyName: String(r.party_name),
    date: String(r.date),
    outstandingKobo: n(r.outstanding),
  }));
}

/**
 * Open receivables as at a Lagos date: non-void invoices with invoice_date ≤
 * asAt and outstanding = total − allocations of payments dated ≤ asAt > 0.
 * Origin = invoice_date.
 */
export async function openReceivables(
  db: DbOrTx,
  ctx: OrgContext,
  asAt: string,
  customerId?: string,
): Promise<OpenItem[]> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT * FROM (
        SELECT i.id, i.customer_id AS party_id, cu.name AS party_name, i.invoice_date::text AS date,
          i.total_kobo
          - coalesce((SELECT sum(a.amount_kobo) FROM customer_payment_allocations a
                      JOIN customer_payments cp ON cp.id = a.payment_id
                      WHERE a.invoice_id = i.id AND cp.payment_date <= ${asAt}::date), 0)
          AS outstanding
        FROM invoices i
        JOIN customers cu ON cu.id = i.customer_id
        WHERE i.organisation_id = ${ctx.orgId}
          AND i.status <> 'void'
          AND i.invoice_date <= ${asAt}::date
          ${opt(customerId, sql`AND i.customer_id = ${customerId}::uuid`)}
      ) x WHERE outstanding > 0
      ORDER BY date, id
    `),
  );
  return rows.map((r) => ({
    id: String(r.id),
    partyId: String(r.party_id),
    partyName: String(r.party_name),
    date: String(r.date),
    outstandingKobo: n(r.outstanding),
  }));
}

export type AgeingRow = {
  partyId: string;
  partyName: string;
  items: number;
  oldestDays: number;
  totalKobo: Kobo;
} & Record<AgeBand, Kobo>;

const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function ageItems(items: OpenItem[], asAt: string): AgeingRow[] {
  const asOf = dateOf(asAt);
  const byParty = new Map<string, OpenItem[]>();
  for (const it of items) {
    const list = byParty.get(it.partyId) ?? [];
    list.push(it);
    byParty.set(it.partyId, list);
  }
  return [...byParty.values()]
    .map((list) => {
      const bands = bucketByAge(list, (i) => dateOf(i.date), (i) => i.outstandingKobo, asOf);
      return {
        partyId: list[0].partyId,
        partyName: list[0].partyName,
        items: list.length,
        oldestDays: Math.max(...list.map((i) => ageInDays(asOf, dateOf(i.date)))),
        ...bands,
        totalKobo: AGE_BANDS.reduce((s, b) => s + bands[b], 0),
      };
    })
    .sort((a, b) => b.totalKobo - a.totalKobo);
}

function ageingColumns(partyLabel: string): ReportColumn<AgeingRow>[] {
  return [
    { key: "partyName", label: partyLabel, type: "text" },
    { key: "items", label: "Open items", type: "int" },
    { key: "oldestDays", label: "Oldest (days)", type: "int" },
    { key: "d0_30", label: "0–30 days", type: "kobo" },
    { key: "d31_60", label: "31–60 days", type: "kobo" },
    { key: "d61_90", label: "61–90 days", type: "kobo" },
    { key: "d90_plus", label: "Over 90 days", type: "kobo" },
    { key: "totalKobo", label: "Total", type: "kobo" },
  ];
}

const AGEING_SUMS: (keyof AgeingRow)[] = ["items", "d0_30", "d31_60", "d61_90", "d90_plus", "totalKobo"];

export async function payablesAgeingReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: PayablesAgeingReportInput,
): Promise<ReportResult<AgeingRow>> {
  const rows = ageItems(await openPayables(db, ctx, p.asAt, p.supplierId), p.asAt);
  return finalize(ctx, {
    key: "payables-ageing",
    title: "Payables ageing",
    subtitle: `Owed to suppliers as at ${p.asAt}`,
    columns: ageingColumns("Supplier"),
    rows,
    totals: totalsOf(rows, "partyName", AGEING_SUMS, []),
  });
}

export async function receivablesAgeingReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: ReceivablesAgeingReportInput,
): Promise<ReportResult<AgeingRow>> {
  const rows = ageItems(await openReceivables(db, ctx, p.asAt, p.customerId), p.asAt);
  return finalize(ctx, {
    key: "receivables-ageing",
    title: "Receivables ageing",
    subtitle: `Owed by customers as at ${p.asAt}`,
    columns: ageingColumns("Customer"),
    rows,
    totals: totalsOf(rows, "partyName", AGEING_SUMS, []),
  });
}

// ── 8. Supplier performance ──────────────────────────────────────────────────

export type SupplierPerformanceRow = {
  supplierId: string;
  supplierName: string;
  supplierType: string;
  purchases: number;
  lines: number;
  grossKg: string;
  netKg: string;
  deductionKg: string;
  avgDeductionPercent: number;
  moistureKg: string;
  foreignMatterKg: string;
  sackWeightKg: string;
  otherDeductionKg: string;
  overGuideLines: number;
  amountKobo: Kobo;
  avgPricePerKgKobo: number;
};

/** avgDeductionPercent = Σ(gross − net) / Σ gross × 100 (weight-weighted), 2 dp. */
export async function supplierPerformanceReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: SupplierPerformanceReportInput,
): Promise<ReportResult<SupplierPerformanceRow>> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT s.id, s.name, s.type, count(DISTINCT p.id) AS purchases, count(pl.id) AS lines,
        coalesce(sum(pl.gross_kg), 0) AS gross, coalesce(sum(pl.net_kg), 0) AS net,
        coalesce(sum(d.moisture), 0) AS moisture, coalesce(sum(d.foreign_matter), 0) AS foreign_matter,
        coalesce(sum(d.sack), 0) AS sack, coalesce(sum(d.other), 0) AS other,
        count(*) FILTER (WHERE pl.over_guide) AS over_guide,
        coalesce(sum(pl.amount_kobo), 0) AS amount
      FROM purchases p
      JOIN purchase_lines pl ON pl.purchase_id = p.id
      JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN (
        SELECT purchase_line_id,
          sum(kg) FILTER (WHERE reason = 'moisture') AS moisture,
          sum(kg) FILTER (WHERE reason = 'foreign_matter') AS foreign_matter,
          sum(kg) FILTER (WHERE reason = 'sack_weight') AS sack,
          sum(kg) FILTER (WHERE reason = 'other') AS other
        FROM purchase_line_deductions
        WHERE organisation_id = ${ctx.orgId}
        GROUP BY purchase_line_id
      ) d ON d.purchase_line_id = pl.id
      WHERE p.organisation_id = ${ctx.orgId}
        AND p.status <> 'cancelled'
        AND p.purchase_date BETWEEN ${p.from}::date AND ${p.to}::date
        ${opt(p.supplierId, sql`AND p.supplier_id = ${p.supplierId}::uuid`)}
        ${opt(p.commodityId, sql`AND pl.commodity_id = ${p.commodityId}::uuid`)}
      GROUP BY s.id, s.name, s.type
      ORDER BY net DESC, s.name
    `),
  );
  const out: SupplierPerformanceRow[] = rows.map((r) => {
    const gross = g(r.gross);
    const net = g(r.net);
    const amount = n(r.amount);
    return {
      supplierId: String(r.id),
      supplierName: String(r.name),
      supplierType: String(r.type),
      purchases: n(r.purchases),
      lines: n(r.lines),
      grossKg: gramsToKg(gross),
      netKg: gramsToKg(net),
      deductionKg: gramsToKg(gross - net),
      avgDeductionPercent: pct(gross - net, gross),
      moistureKg: gramsToKg(g(r.moisture)),
      foreignMatterKg: gramsToKg(g(r.foreign_matter)),
      sackWeightKg: gramsToKg(g(r.sack)),
      otherDeductionKg: gramsToKg(g(r.other)),
      overGuideLines: n(r.over_guide),
      amountKobo: amount,
      avgPricePerKgKobo: perKg(amount, net),
    };
  });
  const totals = totalsOf(
    out,
    "supplierName",
    ["purchases", "lines", "overGuideLines", "amountKobo"],
    ["grossKg", "netKg", "deductionKg", "moistureKg", "foreignMatterKg", "sackWeightKg", "otherDeductionKg"],
  );
  if (totals) {
    const gross = kgToGrams(String(totals.grossKg));
    const net = kgToGrams(String(totals.netKg));
    totals.avgDeductionPercent = pct(gross - net, gross);
    totals.avgPricePerKgKobo = perKg(Number(totals.amountKobo), net);
  }
  return finalize(ctx, {
    key: "supplier-performance",
    title: "Supplier performance",
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "supplierName", label: "Supplier", type: "text" },
      { key: "supplierType", label: "Type", type: "text" },
      { key: "purchases", label: "Purchases", type: "int" },
      { key: "grossKg", label: "Gross kg", type: "kg" },
      { key: "netKg", label: "Net kg", type: "kg" },
      { key: "deductionKg", label: "Deductions kg", type: "kg" },
      { key: "avgDeductionPercent", label: "Avg deduction %", type: "percent" },
      { key: "moistureKg", label: "Moisture kg", type: "kg" },
      { key: "foreignMatterKg", label: "Foreign matter kg", type: "kg" },
      { key: "sackWeightKg", label: "Sack kg", type: "kg" },
      { key: "overGuideLines", label: "Over-guide lines", type: "int" },
      { key: "amountKobo", label: "Amount", type: "kobo" },
      { key: "avgPricePerKgKobo", label: "Avg price / kg", type: "rate" },
    ],
    rows: out,
    totals,
  });
}

// ── 9. Shrinkage & losses ────────────────────────────────────────────────────

export type ShrinkageRow = {
  source: "adjustment" | "transfer_loss" | "transit_loss";
  sourceLabel: string;
  reason: string;
  commodityName: string;
  events: number;
  /** Positive = stock lost; negative = stock gained (positive adjustments). */
  lossKg: string;
  lossValueKobo: Kobo;
};

/**
 * - Posted adjustments (their adjustment movements, by occurred_at) grouped by reason.
 * - Transfer losses: transfer_lines.loss_kg of received transfers (by received_at).
 * - Dispatch transit losses: dispatches.transit_loss_kg (by delivered_at), split
 *   across the dispatch's lots pro rata to dispatched kg for commodity + value.
 * Value = kg × the lot's CURRENT landed rate, rounded half-up to kobo per group.
 */
export async function shrinkageReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: ShrinkageReportInput,
): Promise<ReportResult<ShrinkageRow>> {
  const commodity = opt(p.commodityId, sql`AND l.commodity_id = ${p.commodityId}::uuid`);
  const adj = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT a.reason::text AS reason, c.name AS commodity, count(*) AS events,
        -sum(m.kg) AS loss_kg, -round(sum(m.kg * l.landed_cost_per_kg_kobo)) AS loss_value
      FROM stock_movements m
      JOIN adjustments a ON a.id = m.ref_id
      JOIN lots l ON l.id = m.lot_id
      JOIN commodities c ON c.id = l.commodity_id
      WHERE m.organisation_id = ${ctx.orgId}
        AND m.type = 'adjustment' AND m.ref_type = 'adj'
        AND ${lagosDate(sql`m.occurred_at`)} BETWEEN ${p.from}::date AND ${p.to}::date
        AND ${warehouseScope(ctx, sql`m.warehouse_id`)}
        ${opt(p.warehouseId, sql`AND m.warehouse_id = ${p.warehouseId}::uuid`)}
        ${commodity}
      GROUP BY a.reason, c.name
    `),
  );
  const trf = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT c.name AS commodity, count(*) AS events, sum(tl.loss_kg) AS loss_kg,
        round(sum(tl.loss_kg * l.landed_cost_per_kg_kobo)) AS loss_value
      FROM transfer_lines tl
      JOIN transfers t ON t.id = tl.transfer_id
      JOIN lots l ON l.id = tl.lot_id
      JOIN commodities c ON c.id = l.commodity_id
      WHERE tl.organisation_id = ${ctx.orgId}
        AND t.status = 'received' AND tl.loss_kg > 0
        AND ${lagosDate(sql`t.received_at`)} BETWEEN ${p.from}::date AND ${p.to}::date
        AND (${warehouseScope(ctx, sql`t.from_warehouse_id`)} OR ${warehouseScope(ctx, sql`t.to_warehouse_id`)})
        ${opt(
          p.warehouseId,
          sql`AND (t.from_warehouse_id = ${p.warehouseId}::uuid OR t.to_warehouse_id = ${p.warehouseId}::uuid)`,
        )}
        ${commodity}
      GROUP BY c.name
    `),
  );
  const transit = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT c.name AS commodity, count(DISTINCT d.id) AS events,
        sum(d.transit_loss_kg * dl.kg / d.dispatched_kg) AS loss_kg,
        round(sum(d.transit_loss_kg * dl.kg / d.dispatched_kg * l.landed_cost_per_kg_kobo)) AS loss_value
      FROM dispatches d
      JOIN dispatch_lines dl ON dl.dispatch_id = d.id
      JOIN lot_allocations la ON la.id = dl.lot_allocation_id
      JOIN lots l ON l.id = la.lot_id
      JOIN commodities c ON c.id = l.commodity_id
      WHERE d.organisation_id = ${ctx.orgId}
        AND d.transit_loss_kg > 0 AND d.dispatched_kg > 0
        AND ${lagosDate(sql`d.delivered_at`)} BETWEEN ${p.from}::date AND ${p.to}::date
        AND ${warehouseScope(ctx, sql`la.warehouse_id`)}
        ${opt(p.warehouseId, sql`AND la.warehouse_id = ${p.warehouseId}::uuid`)}
        ${commodity}
      GROUP BY c.name
    `),
  );
  /** numeric loss kg (may carry > 3 dp from the pro-rata split) → 3-dp kg string. */
  const kg3 = (v: unknown) => gramsToKg(kgToGrams(String(v ?? "0")));
  const out: ShrinkageRow[] = [
    ...adj.map((r) => ({
      source: "adjustment" as const,
      sourceLabel: "Adjustment",
      reason: String(r.reason),
      commodityName: String(r.commodity),
      events: n(r.events),
      lossKg: kg3(r.loss_kg),
      lossValueKobo: n(r.loss_value),
    })),
    ...trf.map((r) => ({
      source: "transfer_loss" as const,
      sourceLabel: "Transfer loss",
      reason: "in_transit",
      commodityName: String(r.commodity),
      events: n(r.events),
      lossKg: kg3(r.loss_kg),
      lossValueKobo: n(r.loss_value),
    })),
    ...transit.map((r) => ({
      source: "transit_loss" as const,
      sourceLabel: "Delivery transit loss",
      reason: "delivery",
      commodityName: String(r.commodity),
      events: n(r.events),
      lossKg: kg3(r.loss_kg),
      lossValueKobo: n(r.loss_value),
    })),
  ].sort((a, b) =>
    a.source === b.source
      ? a.reason === b.reason
        ? a.commodityName.localeCompare(b.commodityName)
        : a.reason.localeCompare(b.reason)
      : a.source.localeCompare(b.source),
  );
  return finalize(ctx, {
    key: "shrinkage",
    title: "Shrinkage and losses",
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "sourceLabel", label: "Source", type: "text" },
      { key: "reason", label: "Reason", type: "text" },
      { key: "commodityName", label: "Commodity", type: "text" },
      { key: "events", label: "Events", type: "int" },
      { key: "lossKg", label: "Loss kg", type: "kg" },
      { key: "lossValueKobo", label: "Loss value", type: "kobo" },
    ],
    rows: out,
    totals: totalsOf(out, "sourceLabel", ["events", "lossValueKobo"], ["lossKg"]),
  });
}

// ── 10. Trip costs ───────────────────────────────────────────────────────────

export type TripCostRow = {
  tripId: string;
  tripNumber: string;
  tripDate: string;
  direction: string;
  vehiclePlate: string | null;
  driverName: string | null;
  origin: string | null;
  destination: string | null;
  linkedDocs: number;
  linkedKg: string;
  costKobo: Kobo;
  expensesKobo: Kobo;
  totalKobo: Kobo;
  costPerKgKobo: number;
};

/** Linked kg = Σ purchase_lines.net_kg of linked purchases (inbound) or Σ dispatched_kg (outbound). */
export async function tripCostsReport(
  db: DbOrTx,
  ctx: OrgContext,
  p: TripCostsReportInput,
): Promise<ReportResult<TripCostRow>> {
  const rows = execRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT t.id, t.trip_number, t.trip_date::text AS trip_date, t.direction::text AS direction,
        v.plate_number, dr.name AS driver, t.origin, t.destination, t.cost_kobo,
        (SELECT coalesce(sum(e.amount_kobo), 0) FROM expenses e WHERE e.trip_id = t.id) AS expenses,
        CASE WHEN t.direction = 'inbound'
          THEN (SELECT count(*) FROM trip_purchases tp WHERE tp.trip_id = t.id)
          ELSE (SELECT count(*) FROM trip_dispatches td WHERE td.trip_id = t.id) END AS docs,
        CASE WHEN t.direction = 'inbound'
          THEN (SELECT coalesce(sum(pl.net_kg), 0) FROM trip_purchases tp
                JOIN purchase_lines pl ON pl.purchase_id = tp.purchase_id WHERE tp.trip_id = t.id)
          ELSE (SELECT coalesce(sum(d.dispatched_kg), 0) FROM trip_dispatches td
                JOIN dispatches d ON d.id = td.dispatch_id WHERE td.trip_id = t.id) END AS linked_kg
      FROM trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = t.driver_id
      WHERE t.organisation_id = ${ctx.orgId}
        AND t.trip_date BETWEEN ${p.from}::date AND ${p.to}::date
        ${opt(p.direction, sql`AND t.direction = ${p.direction}`)}
        ${opt(p.vehicleId, sql`AND t.vehicle_id = ${p.vehicleId}::uuid`)}
      ORDER BY t.trip_date, t.trip_number
    `),
  );
  const out: TripCostRow[] = rows.map((r) => {
    const cost = n(r.cost_kobo);
    const exp = n(r.expenses);
    const grams = g(r.linked_kg);
    return {
      tripId: String(r.id),
      tripNumber: String(r.trip_number),
      tripDate: String(r.trip_date),
      direction: String(r.direction),
      vehiclePlate: (r.plate_number as string | null) ?? null,
      driverName: (r.driver as string | null) ?? null,
      origin: (r.origin as string | null) ?? null,
      destination: (r.destination as string | null) ?? null,
      linkedDocs: n(r.docs),
      linkedKg: gramsToKg(grams),
      costKobo: cost,
      expensesKobo: exp,
      totalKobo: cost + exp,
      costPerKgKobo: perKg(cost + exp, grams),
    };
  });
  const totals = totalsOf(out, "tripNumber", ["linkedDocs", "costKobo", "expensesKobo", "totalKobo"], ["linkedKg"]);
  if (totals) totals.costPerKgKobo = perKg(Number(totals.totalKobo), kgToGrams(String(totals.linkedKg)));
  return finalize(ctx, {
    key: "trip-costs",
    title: "Trip costs",
    subtitle: `${p.from} → ${p.to}`,
    columns: [
      { key: "tripNumber", label: "Trip", type: "text" },
      { key: "tripDate", label: "Date", type: "date" },
      { key: "direction", label: "Direction", type: "text" },
      { key: "vehiclePlate", label: "Vehicle", type: "text" },
      { key: "driverName", label: "Driver", type: "text" },
      { key: "origin", label: "From", type: "text" },
      { key: "destination", label: "To", type: "text" },
      { key: "linkedDocs", label: "Loads", type: "int" },
      { key: "linkedKg", label: "Kg carried", type: "kg" },
      { key: "costKobo", label: "Trip cost", type: "kobo" },
      { key: "expensesKobo", label: "Expenses", type: "kobo" },
      { key: "totalKobo", label: "Total", type: "kobo" },
      { key: "costPerKgKobo", label: "Cost / kg", type: "rate" },
    ],
    rows: out,
    totals,
  });
}

// ── generic runner (page + export route) ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReportResult = ReportResult<any>;

export async function runReport(db: DbOrTx, ctx: OrgContext, input: RunReportInput): Promise<AnyReportResult> {
  switch (input.report) {
    case "purchases":
      return purchasesReport(db, ctx, input.params);
    case "stock-position":
      return stockPositionReport(db, ctx, input.params);
    case "stock-movements":
      return stockMovementsReport(db, ctx, input.params);
    case "sales-by-customer":
      return salesByCustomerReport(db, ctx, input.params);
    case "margin":
      return marginReport(db, ctx, input.params);
    case "payables-ageing":
      return payablesAgeingReport(db, ctx, input.params);
    case "receivables-ageing":
      return receivablesAgeingReport(db, ctx, input.params);
    case "supplier-performance":
      return supplierPerformanceReport(db, ctx, input.params);
    case "shrinkage":
      return shrinkageReport(db, ctx, input.params);
    case "trip-costs":
      return tripCostsReport(db, ctx, input.params);
  }
}
