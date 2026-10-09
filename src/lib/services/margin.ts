import { and, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import {
  commodities,
  customers,
  dispatchLines,
  dispatches,
  expenseCategories,
  expenses,
  grades,
  lotAllocations,
  lots,
  salesLines,
  salesOrders,
  suppliers,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { computeMargin, dispatchedCostKobo } from "@/lib/domain/margin";
import { gramsToKg, kgToGrams, parseLandedRate, type Grams, type Kobo } from "@/lib/domain/units";
import { computeLineAmountKobo } from "@/lib/domain/weights";

/**
 * Margin (DOMAIN-ENGINE §11) over dispatched stock.
 *
 * Atom = one dispatch_line (kg of one lot against one sales line):
 *   revenue = computeLineAmountKobo(g, sales_line.price_per_kg_kobo)  (half-up kobo)
 *   cost    = dispatchedCostKobo(g, lot.landed_cost_per_kg_kobo)      (CURRENT rate — late-cost rule)
 * Per lot / sale / customer / commodity margins are sums of the same atoms, so
 * they always reconcile with each other.
 *
 * Expenses: per LOT = Σ NON-landed-cost expenses attached to the lot (landed
 * ones are already inside the rate). Per sale = 0 (DOMAIN-ENGINE §11: revenue
 * − landed cost); customer / commodity = Σ of their sales.
 *
 * Date filter (optional, Lagos calendar dates, inclusive): dispatch lines by
 * dispatches.dispatched_at; lot expenses by expense_date.
 */

export type MarginFilter = {
  from?: string;
  to?: string;
  customerId?: string;
  commodityId?: string;
  lotIds?: string[];
  salesOrderIds?: string[];
};

type MarginCore = {
  dispatchedKg: string;
  revenueKobo: Kobo;
  costKobo: Kobo;
  expensesKobo: Kobo;
  marginKobo: Kobo;
  marginPercent: number;
};

export type LotMarginRow = MarginCore & {
  lotId: string;
  lotNumber: string;
  commodityId: string;
  commodityName: string;
  gradeName: string;
  supplierId: string;
  supplierName: string;
  landedCostPerKgKobo: string;
};

export type SaleMarginRow = MarginCore & {
  salesOrderId: string;
  orderNumber: string;
  orderDate: string;
  customerId: string;
  customerName: string;
};

export type CustomerMarginRow = MarginCore & { customerId: string; customerName: string; sales: number };
export type CommodityMarginRow = MarginCore & { commodityId: string; commodityName: string; sales: number };

type Fact = {
  grams: Grams;
  revenueKobo: Kobo;
  costKobo: Kobo;
  lotId: string;
  lotNumber: string;
  landed: string;
  commodityId: string;
  commodityName: string;
  gradeName: string;
  supplierId: string;
  supplierName: string;
  salesOrderId: string;
  orderNumber: string;
  orderDate: string;
  customerId: string;
  customerName: string;
};

const lagosDate = (col: unknown) => sql`(${col} AT TIME ZONE 'Africa/Lagos')::date`;

/** Every dispatch-line atom matching the filter, with revenue and cost computed. */
export async function marginFacts(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<Fact[]> {
  const where: SQL[] = [eq(dispatchLines.organisationId, ctx.orgId), ne(salesOrders.status, "cancelled")];
  if (f.from) where.push(sql`${lagosDate(dispatches.dispatchedAt)} >= ${f.from}::date`);
  if (f.to) where.push(sql`${lagosDate(dispatches.dispatchedAt)} <= ${f.to}::date`);
  if (f.customerId) where.push(eq(salesOrders.customerId, f.customerId));
  if (f.commodityId) where.push(eq(lots.commodityId, f.commodityId));
  if (f.lotIds) {
    if (f.lotIds.length === 0) return [];
    where.push(inArray(lots.id, f.lotIds));
  }
  if (f.salesOrderIds) {
    if (f.salesOrderIds.length === 0) return [];
    where.push(inArray(salesOrders.id, f.salesOrderIds));
  }

  const rows = await db
    .select({
      kg: dispatchLines.kg,
      price: salesLines.pricePerKgKobo,
      lotId: lots.id,
      lotNumber: lots.lotNumber,
      landed: lots.landedCostPerKgKobo,
      commodityId: lots.commodityId,
      commodityName: commodities.name,
      gradeName: grades.name,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      salesOrderId: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      orderDate: salesOrders.orderDate,
      customerId: customers.id,
      customerName: customers.name,
    })
    .from(dispatchLines)
    .innerJoin(dispatches, eq(dispatches.id, dispatchLines.dispatchId))
    .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
    .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
    .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
    .innerJoin(salesOrders, eq(salesOrders.id, salesLines.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .innerJoin(suppliers, eq(suppliers.id, lots.supplierId))
    .where(and(...where));

  return rows.map((r) => {
    const grams = kgToGrams(r.kg);
    return {
      grams,
      revenueKobo: computeLineAmountKobo(grams, r.price),
      costKobo: dispatchedCostKobo(grams, parseLandedRate(r.landed)),
      lotId: r.lotId,
      lotNumber: r.lotNumber,
      landed: r.landed,
      commodityId: r.commodityId,
      commodityName: r.commodityName,
      gradeName: r.gradeName,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      salesOrderId: r.salesOrderId,
      orderNumber: r.orderNumber,
      orderDate: r.orderDate,
      customerId: r.customerId,
      customerName: r.customerName,
    };
  });
}

type Acc = { grams: Grams; revenue: Kobo; cost: Kobo; expenses: Kobo; sales: Set<string> };
const newAcc = (): Acc => ({ grams: 0, revenue: 0, cost: 0, expenses: 0, sales: new Set() });

function core(a: Acc): MarginCore {
  const m = computeMargin(a.revenue, a.cost, a.expenses);
  return {
    dispatchedKg: gramsToKg(a.grams),
    revenueKobo: a.revenue,
    costKobo: a.cost,
    expensesKobo: a.expenses,
    marginKobo: m.marginKobo,
    marginPercent: m.marginPercent,
  };
}

function groupFacts<K extends string>(facts: Fact[], key: (f: Fact) => K): Map<K, { acc: Acc; first: Fact }> {
  const out = new Map<K, { acc: Acc; first: Fact }>();
  for (const f of facts) {
    const k = key(f);
    let g = out.get(k);
    if (!g) {
      g = { acc: newAcc(), first: f };
      out.set(k, g);
    }
    g.acc.grams += f.grams;
    g.acc.revenue += f.revenueKobo;
    g.acc.cost += f.costKobo;
    g.acc.sales.add(f.salesOrderId);
  }
  return out;
}

const byMarginDesc = <T extends { marginKobo: number }>(a: T, b: T) => b.marginKobo - a.marginKobo;

export async function marginByLot(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<LotMarginRow[]> {
  if (f.lotIds && f.lotIds.length === 0) return [];
  const facts = await marginFacts(db, ctx, f);
  const groups = groupFacts(facts, (x) => x.lotId);

  // Non-landed-cost expenses attached to lots (in range when a range is given).
  const expWhere: SQL[] = [
    eq(expenses.organisationId, ctx.orgId),
    sql`${expenses.lotId} IS NOT NULL`,
    eq(expenseCategories.affectsLandedCost, false),
  ];
  if (f.from) expWhere.push(gte(expenses.expenseDate, f.from));
  if (f.to) expWhere.push(lte(expenses.expenseDate, f.to));
  if (f.lotIds) expWhere.push(inArray(expenses.lotId, f.lotIds));
  if (f.commodityId) expWhere.push(eq(lots.commodityId, f.commodityId));
  const expRows = f.customerId || f.salesOrderIds
    ? [] // customer / sale scoped views carry no lot expenses
    : await db
        .select({
          lotId: lots.id,
          total: sql<string>`sum(${expenses.amountKobo})`,
          lotNumber: lots.lotNumber,
          landed: lots.landedCostPerKgKobo,
          commodityId: lots.commodityId,
          commodityName: commodities.name,
          gradeName: grades.name,
          supplierId: suppliers.id,
          supplierName: suppliers.name,
        })
        .from(expenses)
        .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
        .innerJoin(lots, eq(lots.id, expenses.lotId))
        .innerJoin(commodities, eq(commodities.id, lots.commodityId))
        .innerJoin(grades, eq(grades.id, lots.gradeId))
        .innerJoin(suppliers, eq(suppliers.id, lots.supplierId))
        .where(and(...expWhere))
        .groupBy(lots.id, commodities.name, grades.name, suppliers.id, suppliers.name);

  type Meta = Omit<LotMarginRow, keyof MarginCore>;
  const meta = new Map<string, Meta>();
  for (const [lotId, g] of groups) {
    meta.set(lotId, {
      lotId,
      lotNumber: g.first.lotNumber,
      commodityId: g.first.commodityId,
      commodityName: g.first.commodityName,
      gradeName: g.first.gradeName,
      supplierId: g.first.supplierId,
      supplierName: g.first.supplierName,
      landedCostPerKgKobo: g.first.landed,
    });
  }
  const accs = new Map<string, Acc>([...groups].map(([k, g]) => [k, g.acc]));
  for (const e of expRows) {
    if (!meta.has(e.lotId)) {
      meta.set(e.lotId, {
        lotId: e.lotId,
        lotNumber: e.lotNumber,
        commodityId: e.commodityId,
        commodityName: e.commodityName,
        gradeName: e.gradeName,
        supplierId: e.supplierId,
        supplierName: e.supplierName,
        landedCostPerKgKobo: e.landed,
      });
      accs.set(e.lotId, newAcc());
    }
    accs.get(e.lotId)!.expenses += Number(e.total);
  }

  return [...meta.values()]
    .map((m) => ({ ...m, ...core(accs.get(m.lotId)!) }))
    .sort((a, b) => a.lotNumber.localeCompare(b.lotNumber));
}

export async function marginBySale(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<SaleMarginRow[]> {
  const groups = groupFacts(await marginFacts(db, ctx, f), (x) => x.salesOrderId);
  return [...groups.values()]
    .map(({ acc, first }) => ({
      salesOrderId: first.salesOrderId,
      orderNumber: first.orderNumber,
      orderDate: first.orderDate,
      customerId: first.customerId,
      customerName: first.customerName,
      ...core(acc),
    }))
    .sort((a, b) => (a.orderDate === b.orderDate ? a.orderNumber.localeCompare(b.orderNumber) : a.orderDate < b.orderDate ? -1 : 1));
}

export async function marginByCustomer(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<CustomerMarginRow[]> {
  const groups = groupFacts(await marginFacts(db, ctx, f), (x) => x.customerId);
  return [...groups.values()]
    .map(({ acc, first }) => ({
      customerId: first.customerId,
      customerName: first.customerName,
      sales: acc.sales.size,
      ...core(acc),
    }))
    .sort(byMarginDesc);
}

export async function marginByCommodity(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<CommodityMarginRow[]> {
  const groups = groupFacts(await marginFacts(db, ctx, f), (x) => x.commodityId);
  return [...groups.values()]
    .map(({ acc, first }) => ({
      commodityId: first.commodityId,
      commodityName: first.commodityName,
      sales: acc.sales.size,
      ...core(acc),
    }))
    .sort(byMarginDesc);
}

/** Totals over the sale view (revenue − landed cost) — used by the dashboard. */
export async function marginTotals(db: DbOrTx, ctx: OrgContext, f: MarginFilter = {}): Promise<MarginCore> {
  const acc = newAcc();
  for (const x of await marginFacts(db, ctx, f)) {
    acc.grams += x.grams;
    acc.revenue += x.revenueKobo;
    acc.cost += x.costKobo;
  }
  return core(acc);
}

/** Single-lot margin (lot page). Null when the lot has neither dispatches nor expenses. */
export async function lotMargin(db: DbOrTx, ctx: OrgContext, lotId: string): Promise<LotMarginRow | null> {
  return (await marginByLot(db, ctx, { lotIds: [lotId] }))[0] ?? null;
}

/** Single-sale margin (sale page). Null when nothing is dispatched yet. */
export async function saleMargin(db: DbOrTx, ctx: OrgContext, salesOrderId: string): Promise<SaleMarginRow | null> {
  return (await marginBySale(db, ctx, { salesOrderIds: [salesOrderId] }))[0] ?? null;
}
