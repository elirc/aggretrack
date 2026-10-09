import { and, asc, count, desc, eq, gte, inArray, lt, sql, type Column, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  bins,
  commodities,
  grades,
  lots,
  purchaseLines,
  purchases,
  stockMovements,
  suppliers,
  transferLines,
  transfers,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { AGE_BANDS, ageBand, ageInDays, bucketByAge, type AgeBand } from "@/lib/domain/ageing";
import { DomainError } from "@/lib/domain/errors";
import { dispatchedCostKobo } from "@/lib/domain/margin";
import { gramsToKg, kgToGrams, parseLandedRate, type Grams, type Kobo } from "@/lib/domain/units";
import type {
  InTransitQuery,
  LotDetailQuery,
  MovementHistoryQuery,
  StockAgeingQuery,
  StockPositionQuery,
} from "@/lib/validation/warehouse";

/**
 * Stock read models (P2-B). Every query is scoped by ctx.orgId AND the
 * caller's warehouse restriction (ctx.restrictions.warehouseIds; null = all).
 * When ctx.restrictions.hidePrices is on, price/value fields are OMITTED from
 * returned rows (not zeroed) — they are typed optional for that reason.
 *
 * On hand is always Σ stock_movements.kg per lot × warehouse (read-only here;
 * stockCore.postMovements is the only writer).
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ── Shared helpers (also used by transfers / counts / adjustments / alertRules) ──

/** True when the caller may see/act on this warehouse. */
export function canAccessWarehouse(ctx: OrgContext, warehouseId: string): boolean {
  const allowed = ctx.restrictions.warehouseIds;
  return allowed === null || allowed.includes(warehouseId);
}

/** Throws FORBIDDEN when the caller is restricted away from this warehouse. */
export function assertWarehouseAccess(ctx: OrgContext, warehouseId: string): void {
  if (!canAccessWarehouse(ctx, warehouseId)) {
    throw new DomainError("FORBIDDEN", "You do not have access to this warehouse");
  }
}

/** SQL filter for a warehouse id column honouring the caller's restriction (undefined = no filter). */
export function warehouseFilter(ctx: OrgContext, column: Column): SQL | undefined {
  const allowed = ctx.restrictions.warehouseIds;
  if (allowed === null) return undefined;
  return inArray(column, allowed.length ? allowed : [NIL_UUID]);
}

/** Org-scoped warehouse row (mutations); NOT_FOUND for foreign/missing ids. */
export async function ownWarehouse(
  db: DbOrTx,
  ctx: OrgContext,
  id: string,
): Promise<typeof warehouses.$inferSelect> {
  const [row] = await db
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, id)))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Warehouse not found");
  return row;
}

/** Org-scoped bin that must belong to the given warehouse. */
export async function assertBinInWarehouse(
  db: DbOrTx,
  ctx: OrgContext,
  binId: string,
  warehouseId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: bins.id })
    .from(bins)
    .where(and(eq(bins.organisationId, ctx.orgId), eq(bins.id, binId), eq(bins.warehouseId, warehouseId)))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Bin not found in this warehouse");
}

/** On hand (grams + bags) for one lot in one warehouse. Read-only. */
export async function onHandAt(
  db: DbOrTx,
  ctx: OrgContext,
  lotId: string,
  warehouseId: string,
): Promise<{ grams: Grams; bags: number }> {
  const [row] = await db
    .select({
      kg: sql<string>`coalesce(sum(${stockMovements.kg}), 0)`,
      bags: sql<string>`coalesce(sum(${stockMovements.bags}), 0)`,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organisationId, ctx.orgId),
        eq(stockMovements.lotId, lotId),
        eq(stockMovements.warehouseId, warehouseId),
      ),
    );
  return { grams: kgToGrams(row?.kg ?? "0"), bags: Number(row?.bags ?? 0) };
}

/** Run fn in a transaction (savepoint when already inside one). */
export async function inTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Tx).transaction(fn);
}

/** Inclusive Lagos (UTC+1, no DST) calendar day → UTC instant at its start. */
export function lagosDayStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+01:00`);
}

function valueKobo(grams: Grams, rate: string): Kobo {
  return dispatchedCostKobo(grams, parseLandedRate(rate));
}

// ── Stock position ──

export type BinBalance = { binId: string | null; binName: string | null; kg: string; grams: Grams; bags: number };

export type LotPositionRow = {
  lotId: string;
  lotNumber: string;
  receivedAt: Date;
  kg: string;
  grams: Grams;
  bags: number;
  bins: BinBalance[];
  landedCostPerKgKobo?: number;
  valueKobo?: Kobo;
};

export type Totals = { kg: string; grams: Grams; bags: number; valueKobo?: Kobo };

export type WarehousePositionNode = Totals & {
  warehouseId: string;
  warehouseName: string;
  lots: LotPositionRow[];
};
export type GradePositionNode = Totals & {
  gradeId: string;
  gradeName: string;
  warehouses: WarehousePositionNode[];
};
export type CommodityPositionNode = Totals & {
  commodityId: string;
  commodityName: string;
  grades: GradePositionNode[];
};
export type StockPosition = { totals: Totals; commodities: CommodityPositionNode[] };

type Acc = { grams: Grams; bags: number; value: Kobo };
const newAcc = (): Acc => ({ grams: 0, bags: 0, value: 0 });

function totals(acc: Acc, hide: boolean): Totals {
  const t: Totals = { kg: gramsToKg(acc.grams), grams: acc.grams, bags: acc.bags };
  if (!hide) t.valueKobo = acc.value;
  return t;
}

type BalanceRow = {
  lotId: string;
  warehouseId: string;
  binId: string | null;
  kg: string;
  bags: string;
};

/** Σ movements per lot × warehouse × bin, org + restriction scoped. */
async function balancesByBin(
  db: DbOrTx,
  ctx: OrgContext,
  extra: SQL[] = [],
): Promise<BalanceRow[]> {
  const where: SQL[] = [eq(stockMovements.organisationId, ctx.orgId), ...extra];
  const wf = warehouseFilter(ctx, stockMovements.warehouseId);
  if (wf) where.push(wf);
  return db
    .select({
      lotId: stockMovements.lotId,
      warehouseId: stockMovements.warehouseId,
      binId: stockMovements.binId,
      kg: sql<string>`sum(${stockMovements.kg})`,
      bags: sql<string>`sum(${stockMovements.bags})`,
    })
    .from(stockMovements)
    .where(and(...where))
    .groupBy(stockMovements.lotId, stockMovements.warehouseId, stockMovements.binId);
}

type LotWarehouseBalance = {
  lotId: string;
  warehouseId: string;
  grams: Grams;
  bags: number;
  bins: { binId: string | null; grams: Grams; bags: number }[];
};

function rollUpBins(rows: BalanceRow[]): LotWarehouseBalance[] {
  const map = new Map<string, LotWarehouseBalance>();
  for (const r of rows) {
    const key = `${r.lotId}|${r.warehouseId}`;
    const b = map.get(key) ?? { lotId: r.lotId, warehouseId: r.warehouseId, grams: 0, bags: 0, bins: [] };
    const g = kgToGrams(r.kg);
    const bg = Number(r.bags);
    b.grams += g;
    b.bags += bg;
    if (g !== 0 || bg !== 0) b.bins.push({ binId: r.binId, grams: g, bags: bg });
    map.set(key, b);
  }
  return [...map.values()];
}

export async function getStockPosition(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<StockPositionQuery> = {},
): Promise<StockPosition> {
  const hide = ctx.restrictions.hidePrices;
  const extra: SQL[] = [];
  if (q.warehouseId) extra.push(eq(stockMovements.warehouseId, q.warehouseId));
  const balances = rollUpBins(await balancesByBin(db, ctx, extra)).filter(
    (b) => b.grams !== 0 || b.bags !== 0,
  );
  if (balances.length === 0) {
    return { totals: totals(newAcc(), hide), commodities: [] };
  }

  const lotIds = [...new Set(balances.map((b) => b.lotId))];
  const lotWhere: SQL[] = [eq(lots.organisationId, ctx.orgId), inArray(lots.id, lotIds)];
  if (q.commodityId) lotWhere.push(eq(lots.commodityId, q.commodityId));
  if (q.gradeId) lotWhere.push(eq(lots.gradeId, q.gradeId));
  const lotRows = await db
    .select({
      id: lots.id,
      lotNumber: lots.lotNumber,
      receivedAt: lots.receivedAt,
      landed: lots.landedCostPerKgKobo,
      commodityId: lots.commodityId,
      commodityName: commodities.name,
      gradeId: lots.gradeId,
      gradeName: grades.name,
    })
    .from(lots)
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .where(and(...lotWhere));
  const lotById = new Map(lotRows.map((l) => [l.id, l]));

  const whIds = [...new Set(balances.map((b) => b.warehouseId))];
  const whRows = await db
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(and(eq(warehouses.organisationId, ctx.orgId), inArray(warehouses.id, whIds)));
  const whName = new Map(whRows.map((w) => [w.id, w.name]));

  const binIds = [
    ...new Set(balances.flatMap((b) => b.bins.map((x) => x.binId)).filter((x): x is string => !!x)),
  ];
  const binRows = binIds.length
    ? await db
        .select({ id: bins.id, name: bins.name })
        .from(bins)
        .where(and(eq(bins.organisationId, ctx.orgId), inArray(bins.id, binIds)))
    : [];
  const binName = new Map(binRows.map((b) => [b.id, b.name]));

  type WNode = { id: string; name: string; acc: Acc; lots: LotPositionRow[] };
  type GNode = { id: string; name: string; acc: Acc; wh: Map<string, WNode> };
  type CNode = { id: string; name: string; acc: Acc; gr: Map<string, GNode> };
  const tree = new Map<string, CNode>();
  const grand = newAcc();

  for (const b of balances) {
    const lot = lotById.get(b.lotId);
    if (!lot) continue; // filtered out by commodity/grade
    const v = valueKobo(b.grams, lot.landed);
    const c = tree.get(lot.commodityId) ?? {
      id: lot.commodityId,
      name: lot.commodityName,
      acc: newAcc(),
      gr: new Map<string, GNode>(),
    };
    tree.set(lot.commodityId, c);
    const g = c.gr.get(lot.gradeId) ?? { id: lot.gradeId, name: lot.gradeName, acc: newAcc(), wh: new Map() };
    c.gr.set(lot.gradeId, g);
    const w = g.wh.get(b.warehouseId) ?? {
      id: b.warehouseId,
      name: whName.get(b.warehouseId) ?? "",
      acc: newAcc(),
      lots: [],
    };
    g.wh.set(b.warehouseId, w);

    const row: LotPositionRow = {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      receivedAt: lot.receivedAt,
      kg: gramsToKg(b.grams),
      grams: b.grams,
      bags: b.bags,
      bins: b.bins.map((x) => ({
        binId: x.binId,
        binName: x.binId ? (binName.get(x.binId) ?? null) : null,
        kg: gramsToKg(x.grams),
        grams: x.grams,
        bags: x.bags,
      })),
    };
    if (!hide) {
      row.landedCostPerKgKobo = parseLandedRate(lot.landed);
      row.valueKobo = v;
    }
    w.lots.push(row);
    for (const acc of [w.acc, g.acc, c.acc, grand]) {
      acc.grams += b.grams;
      acc.bags += b.bags;
      acc.value += v;
    }
  }

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    totals: totals(grand, hide),
    commodities: [...tree.values()].sort(byName).map((c) => ({
      commodityId: c.id,
      commodityName: c.name,
      ...totals(c.acc, hide),
      grades: [...c.gr.values()].sort(byName).map((g) => ({
        gradeId: g.id,
        gradeName: g.name,
        ...totals(g.acc, hide),
        warehouses: [...g.wh.values()].sort(byName).map((w) => ({
          warehouseId: w.id,
          warehouseName: w.name,
          ...totals(w.acc, hide),
          lots: w.lots.sort(
            (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.lotId.localeCompare(b.lotId),
          ),
        })),
      })),
    })),
  };
}

// ── Lot detail ──

export type MovementRow = {
  id: string;
  occurredAt: Date;
  type: (typeof stockMovements.$inferSelect)["type"];
  kg: string;
  grams: Grams;
  bags: number;
  lotId: string;
  lotNumber: string;
  warehouseId: string;
  warehouseName: string;
  binId: string | null;
  binName: string | null;
  refType: string | null;
  refId: string | null;
  createdBy: string | null;
};

export type LotDetail = {
  id: string;
  lotNumber: string;
  commodityId: string;
  commodityName: string;
  gradeId: string;
  gradeName: string;
  supplierId: string;
  supplierName: string;
  purchaseId: string;
  purchaseNumber: string | null;
  receivedAt: Date;
  originalKg: string;
  originalBags: number;
  onHand: { kg: string; grams: Grams; bags: number; valueKobo?: Kobo };
  byWarehouse: {
    warehouseId: string;
    warehouseName: string;
    kg: string;
    grams: Grams;
    bags: number;
    valueKobo?: Kobo;
  }[];
  purchasePricePerKgKobo?: number;
  landedCostPerKgKobo?: number;
  movements: MovementRow[];
};

const movementSelect = {
  id: stockMovements.id,
  occurredAt: stockMovements.occurredAt,
  type: stockMovements.type,
  kg: stockMovements.kg,
  bags: stockMovements.bags,
  lotId: stockMovements.lotId,
  lotNumber: lots.lotNumber,
  warehouseId: stockMovements.warehouseId,
  warehouseName: warehouses.name,
  binId: stockMovements.binId,
  binName: bins.name,
  refType: stockMovements.refType,
  refId: stockMovements.refId,
  createdBy: stockMovements.createdBy,
};

export async function getLotDetail(db: DbOrTx, ctx: OrgContext, q: LotDetailQuery): Promise<LotDetail> {
  const hide = ctx.restrictions.hidePrices;
  const [lot] = await db
    .select({
      id: lots.id,
      lotNumber: lots.lotNumber,
      commodityId: lots.commodityId,
      commodityName: commodities.name,
      gradeId: lots.gradeId,
      gradeName: grades.name,
      supplierId: lots.supplierId,
      supplierName: suppliers.name,
      purchaseId: purchaseLines.purchaseId,
      purchaseNumber: purchases.purchaseNumber,
      receivedAt: lots.receivedAt,
      originalKg: lots.originalKg,
      originalBags: lots.originalBags,
      purchasePrice: lots.purchasePricePerKgKobo,
      landed: lots.landedCostPerKgKobo,
    })
    .from(lots)
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .innerJoin(suppliers, eq(suppliers.id, lots.supplierId))
    .innerJoin(purchaseLines, eq(purchaseLines.id, lots.purchaseLineId))
    .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
    .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, q.lotId)))
    .limit(1);
  if (!lot) throw new DomainError("NOT_FOUND", "Lot not found");

  const where: SQL[] = [eq(stockMovements.organisationId, ctx.orgId), eq(stockMovements.lotId, lot.id)];
  const wf = warehouseFilter(ctx, stockMovements.warehouseId);
  if (wf) where.push(wf);
  const mv = await db
    .select(movementSelect)
    .from(stockMovements)
    .innerJoin(lots, eq(lots.id, stockMovements.lotId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .leftJoin(bins, eq(bins.id, stockMovements.binId))
    .where(and(...where))
    .orderBy(asc(stockMovements.occurredAt), asc(stockMovements.createdAt));

  // A restricted member only sees lots that ever touched their warehouses.
  if (ctx.restrictions.warehouseIds !== null && mv.length === 0) {
    throw new DomainError("NOT_FOUND", "Lot not found");
  }

  const movements: MovementRow[] = mv.map((m) => ({ ...m, grams: kgToGrams(m.kg) }));
  const perWh = new Map<string, { name: string; grams: Grams; bags: number }>();
  for (const m of movements) {
    const w = perWh.get(m.warehouseId) ?? { name: m.warehouseName, grams: 0, bags: 0 };
    w.grams += m.grams;
    w.bags += m.bags;
    perWh.set(m.warehouseId, w);
  }
  let g = 0;
  let bg = 0;
  const byWarehouse: LotDetail["byWarehouse"] = [];
  for (const [warehouseId, w] of perWh) {
    g += w.grams;
    bg += w.bags;
    if (w.grams === 0 && w.bags === 0) continue;
    const row: LotDetail["byWarehouse"][number] = {
      warehouseId,
      warehouseName: w.name,
      kg: gramsToKg(w.grams),
      grams: w.grams,
      bags: w.bags,
    };
    if (!hide) row.valueKobo = valueKobo(w.grams, lot.landed);
    byWarehouse.push(row);
  }

  const out: LotDetail = {
    id: lot.id,
    lotNumber: lot.lotNumber,
    commodityId: lot.commodityId,
    commodityName: lot.commodityName,
    gradeId: lot.gradeId,
    gradeName: lot.gradeName,
    supplierId: lot.supplierId,
    supplierName: lot.supplierName,
    purchaseId: lot.purchaseId,
    purchaseNumber: lot.purchaseNumber,
    receivedAt: lot.receivedAt,
    originalKg: lot.originalKg,
    originalBags: lot.originalBags,
    onHand: { kg: gramsToKg(g), grams: g, bags: bg },
    byWarehouse,
    movements,
  };
  if (!hide) {
    out.onHand.valueKobo = valueKobo(g, lot.landed);
    out.purchasePricePerKgKobo = lot.purchasePrice;
    out.landedCostPerKgKobo = parseLandedRate(lot.landed);
  }
  return out;
}

// ── Stock ageing ──

export type AgeingRow = {
  lotId: string;
  lotNumber: string;
  commodityId: string;
  commodityName: string;
  gradeName: string;
  warehouseId: string;
  warehouseName: string;
  receivedAt: Date;
  ageDays: number;
  band: AgeBand;
  kg: string;
  grams: Grams;
  valueKobo?: Kobo;
};

export type AgeingBandTotal = { kg: string; grams: Grams; valueKobo?: Kobo };

export type StockAgeing = {
  asOf: Date;
  bands: Record<AgeBand, AgeingBandTotal>;
  rows: AgeingRow[];
};

export async function getStockAgeing(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<StockAgeingQuery> = {},
): Promise<StockAgeing> {
  const hide = ctx.restrictions.hidePrices;
  const asOf = q.asOf ?? new Date();
  const where: SQL[] = [eq(stockMovements.organisationId, ctx.orgId)];
  const wf = warehouseFilter(ctx, stockMovements.warehouseId);
  if (wf) where.push(wf);
  if (q.warehouseId) where.push(eq(stockMovements.warehouseId, q.warehouseId));
  if (q.commodityId) where.push(eq(lots.commodityId, q.commodityId));

  const rows = await db
    .select({
      lotId: lots.id,
      lotNumber: lots.lotNumber,
      commodityId: lots.commodityId,
      commodityName: commodities.name,
      gradeName: grades.name,
      warehouseId: stockMovements.warehouseId,
      warehouseName: warehouses.name,
      receivedAt: lots.receivedAt,
      landed: lots.landedCostPerKgKobo,
      kg: sql<string>`sum(${stockMovements.kg})`,
    })
    .from(stockMovements)
    .innerJoin(lots, eq(lots.id, stockMovements.lotId))
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .where(and(...where))
    .groupBy(
      lots.id,
      lots.lotNumber,
      lots.commodityId,
      commodities.name,
      grades.name,
      stockMovements.warehouseId,
      warehouses.name,
      lots.receivedAt,
      lots.landedCostPerKgKobo,
    )
    .having(sql`sum(${stockMovements.kg}) > 0`)
    .orderBy(asc(lots.receivedAt), asc(lots.id));

  const items = rows.map((r) => {
    const grams = kgToGrams(r.kg);
    const ageDays = ageInDays(asOf, r.receivedAt);
    return { r, grams, ageDays, value: valueKobo(grams, r.landed) };
  });

  const gramsByBand = bucketByAge(items, (i) => i.r.receivedAt, (i) => i.grams, asOf);
  const valueByBand = bucketByAge(items, (i) => i.r.receivedAt, (i) => i.value, asOf);
  const bands = {} as Record<AgeBand, AgeingBandTotal>;
  for (const b of AGE_BANDS) {
    bands[b] = { kg: gramsToKg(gramsByBand[b]), grams: gramsByBand[b] };
    if (!hide) bands[b].valueKobo = valueByBand[b];
  }

  return {
    asOf,
    bands,
    rows: items.map(({ r, grams, ageDays, value }) => {
      const row: AgeingRow = {
        lotId: r.lotId,
        lotNumber: r.lotNumber,
        commodityId: r.commodityId,
        commodityName: r.commodityName,
        gradeName: r.gradeName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        receivedAt: r.receivedAt,
        ageDays,
        band: ageBand(ageDays),
        kg: gramsToKg(grams),
        grams,
      };
      if (!hide) row.valueKobo = value;
      return row;
    }),
  };
}

// ── Movement history ──

export type MovementHistory = {
  rows: MovementRow[];
  total: number;
  page: number;
  pageSize: number;
};

export async function getMovementHistory(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<MovementHistoryQuery> = {},
): Promise<MovementHistory> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const where: SQL[] = [eq(stockMovements.organisationId, ctx.orgId)];
  const wf = warehouseFilter(ctx, stockMovements.warehouseId);
  if (wf) where.push(wf);
  if (q.lotId) where.push(eq(stockMovements.lotId, q.lotId));
  if (q.warehouseId) where.push(eq(stockMovements.warehouseId, q.warehouseId));
  if (q.type) where.push(eq(stockMovements.type, q.type));
  if (q.fromDate) where.push(gte(stockMovements.occurredAt, lagosDayStart(q.fromDate)));
  if (q.toDate) {
    const end = lagosDayStart(q.toDate);
    end.setUTCDate(end.getUTCDate() + 1);
    where.push(lt(stockMovements.occurredAt, end));
  }
  const cond = and(...where);

  const [{ n }] = await db.select({ n: count() }).from(stockMovements).where(cond);
  const rows = await db
    .select(movementSelect)
    .from(stockMovements)
    .innerJoin(lots, eq(lots.id, stockMovements.lotId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .leftJoin(bins, eq(bins.id, stockMovements.binId))
    .where(cond)
    .orderBy(desc(stockMovements.occurredAt), desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((m) => ({ ...m, grams: kgToGrams(m.kg) })),
    total: Number(n),
    page,
    pageSize,
  };
}

// ── In transit ──

export type InTransitRow = {
  transferId: string;
  transferNumber: string;
  fromWarehouseId: string;
  fromWarehouseName: string;
  toWarehouseId: string;
  toWarehouseName: string;
  dispatchedAt: Date | null;
  lineId: string;
  lotId: string;
  lotNumber: string;
  commodityName: string;
  gradeName: string;
  kg: string;
  grams: Grams;
  bags: number;
  valueKobo?: Kobo;
};

export async function getInTransit(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<InTransitQuery> = {},
): Promise<InTransitRow[]> {
  const hide = ctx.restrictions.hidePrices;
  const where: SQL[] = [eq(transfers.organisationId, ctx.orgId), eq(transfers.status, "in_transit")];
  const allowed = ctx.restrictions.warehouseIds;
  if (allowed !== null) {
    const ids = allowed.length ? allowed : [NIL_UUID];
    where.push(sql`(${inArray(transfers.fromWarehouseId, ids)} OR ${inArray(transfers.toWarehouseId, ids)})`);
  }
  if (q.warehouseId) {
    where.push(
      sql`(${transfers.fromWarehouseId} = ${q.warehouseId} OR ${transfers.toWarehouseId} = ${q.warehouseId})`,
    );
  }
  const fromWh = sql<string>`(select name from warehouses w where w.id = ${transfers.fromWarehouseId})`;
  const toWh = sql<string>`(select name from warehouses w where w.id = ${transfers.toWarehouseId})`;
  const rows = await db
    .select({
      transferId: transfers.id,
      transferNumber: transfers.transferNumber,
      fromWarehouseId: transfers.fromWarehouseId,
      fromWarehouseName: fromWh,
      toWarehouseId: transfers.toWarehouseId,
      toWarehouseName: toWh,
      dispatchedAt: transfers.dispatchedAt,
      lineId: transferLines.id,
      lotId: transferLines.lotId,
      lotNumber: lots.lotNumber,
      commodityName: commodities.name,
      gradeName: grades.name,
      kg: transferLines.kg,
      bags: transferLines.bags,
      landed: lots.landedCostPerKgKobo,
    })
    .from(transfers)
    .innerJoin(transferLines, eq(transferLines.transferId, transfers.id))
    .innerJoin(lots, eq(lots.id, transferLines.lotId))
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .where(and(...where))
    .orderBy(asc(transfers.dispatchedAt), asc(transfers.transferNumber), asc(transferLines.id));

  return rows.map(({ landed, ...r }) => {
    const grams = kgToGrams(r.kg);
    const row: InTransitRow = { ...r, kg: gramsToKg(grams), grams };
    if (!hide) row.valueKobo = valueKobo(grams, landed);
    return row;
  });
}
