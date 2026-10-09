/**
 * Seed phase 2: three months of coherent operations, simulated day by day
 * (window day 0 = 90 days ago … day 90 = today) BY CALLING THE SERVICES with
 * the context of the role that would do the work. Services stamp some
 * timestamps with now(); right after those calls the seed backdates exactly
 * those columns (received_at / occurred_at / approved_at / posted_at /
 * dispatched_at / created_at) to the simulated moment. That explicit
 * backdating is the ONLY direct write to business tables, and only here.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "../../src/db/client";
import {
  adjustments,
  lotAllocations,
  lots,
  purchases,
  stockCounts,
  stockMovements,
  supplierAdvanceOffsets,
  transferLines,
  transfers,
} from "../../src/db/schema";
import { DomainError } from "../../src/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams, type Kobo } from "../../src/lib/domain/units";
import { createAdvance } from "../../src/lib/services/advances";
import { approveAdjustment, createAdjustment, type Adjustment } from "../../src/lib/services/adjustments";
import { autoAllocateOrder } from "../../src/lib/services/allocation";
import { createCount, postCount } from "../../src/lib/services/counts";
import { recordCustomerPayment } from "../../src/lib/services/customerPayments";
import { createDispatch, recordDelivery } from "../../src/lib/services/dispatches";
import { createExpense } from "../../src/lib/services/expenses";
import { createInvoiceFromDispatch } from "../../src/lib/services/invoices";
import { listOpenPurchases } from "../../src/lib/services/payables";
import { approvePurchase, createPurchase } from "../../src/lib/services/purchases";
import { receivePurchase } from "../../src/lib/services/receiving";
import { confirmSalesOrder, createSalesOrder, type SellingDeps } from "../../src/lib/services/salesOrders";
import { offsetAdvance, recordSupplierPayment } from "../../src/lib/services/supplierPayments";
import { createTransfer, dispatchTransfer, receiveTransfer } from "../../src/lib/services/transfers";
import { createTrip, linkDispatches, linkPurchases } from "../../src/lib/services/trips";
import {
  advanceInput,
  offsetAdvanceInput,
  purchaseCreateInput,
  receivePurchaseInput,
  supplierPaymentInput,
} from "../../src/lib/validation/buying";
import { expenseInput, tripInput, tripLinkDispatchesInput, tripLinkPurchasesInput } from "../../src/lib/validation/logistics";
import {
  adjustmentIdInput,
  countIdInput,
  createAdjustmentInput,
  createCountInput,
  createTransferInput,
  receiveTransferInput,
  transferIdInput,
} from "../../src/lib/validation/warehouse";

import {
  BAG_TYPES,
  BP_COMMODITY_WEIGHTS,
  BUYING_POINTS,
  COMMODITIES,
  GRADES,
  HAULAGE_KOBO,
  type BuyingPointKey,
  type CommodityCode,
  type GradeKey,
} from "./constants";
import { WINDOW_DAYS, type Calendar } from "./dates";
import type { Rng } from "./rng";
import { act, guideFor, priceIndex, type Ctxs, type CustomerRef, type Master, type SupplierRef } from "./setup";

const LAST = WINDOW_DAYS; // day index of today
const N_PURCHASES = 120;
const N_SALES = 60;
/** over-guide purchases approved by the manager next day */
const OVER_GUIDE_APPROVED = new Set([9, 21, 34, 47, 60, 73, 85, 99]);
/** over-guide purchases left in the approval queue */
const OVER_GUIDE_PENDING = new Set([113, 117]);
const TRANSFER_DAYS = [14, 29, 44, 59, 74, 87];
const noopDeps: SellingDeps = { enqueue: async () => undefined };

export type HistoryStats = Record<string, number>;

type LinePlan = {
  code: CommodityCode;
  grade: GradeKey;
  bags: number;
  grossKg: string;
  moisturePercent: string;
  deductions: Array<{ reason: "moisture" | "foreign_matter"; kg: string; note: string | null }>;
  pricePerKgKobo: Kobo;
};

type PurchasePlan = {
  idx: number;
  day: number;
  supplier: SupplierRef;
  bp: BuyingPointKey;
  lines: LinePlan[];
  overGuide: boolean;
  keepPending: boolean;
  lag: number;
};

type ReceivedPurchase = {
  id: string;
  idx: number;
  day: number;
  recvDay: number;
  bp: BuyingPointKey;
  supplierId: string;
  totalKobo: Kobo;
  tripLinked: boolean;
};

type SupplierPayDue = { purchaseId: string; supplierId: string; fraction: number };
type CustomerPayDue = { invoiceId: string; customerId: string; fraction: number };
type OpenDispatch = { id: string; day: number; city: CustomerRef["city"]; linked: boolean };
type LotBalance = {
  lotId: string;
  warehouseId: string;
  onHandG: Grams;
  bags: number;
  reservedG: Grams;
  availG: Grams;
  originalG: Grams;
  originalBags: number;
  receivedAt: Date;
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function kgStr(kg: number): string {
  return (Math.round(kg * 10) / 10).toFixed(1);
}

function round100(kobo: number): Kobo {
  return Math.round(kobo / 100) * 100;
}

export async function seedHistory(
  db: Db,
  rng: Rng,
  cal: Calendar,
  ctxs: Ctxs,
  m: Master,
  suppliers: SupplierRef[],
  customers: CustomerRef[],
): Promise<HistoryStats> {
  const runStartedAt = new Date(Date.now() - 5_000);
  const stats: HistoryStats = {};
  const bump = (k: string, n = 1) => {
    stats[k] = (stats[k] ?? 0) + n;
  };
  const orgId = m.orgId;
  const specByCommodityId = new Map(COMMODITIES.map((c) => [m.commodities[c.code].id, c]));
  const gradeKeyById = new Map<string, GradeKey>();
  for (const c of COMMODITIES) for (const g of GRADES) gradeKeyById.set(m.commodities[c.code].grades[g.key], g.key);
  const gradeFactor = (g: GradeKey) => GRADES.find((x) => x.key === g)!.factor;
  const warehouseFor = (bp: BuyingPointKey) => (bp === "billiri" ? m.warehouses.billiri : m.warehouses.main);
  const receiverFor = (bp: BuyingPointKey) => (bp === "billiri" ? ctxs.manager : ctxs.warehouse);
  const creatorFor = (bp: BuyingPointKey) => (bp === "kaltungo" ? ctxs.owner : ctxs.procurement);

  // ── advances: 10 suppliers (cooperatives + agents first) ─────────────────
  const advanceSuppliers = [
    ...suppliers.filter((s) => s.type === "cooperative"),
    ...suppliers.filter((s) => s.type === "agent").slice(0, 3),
    ...suppliers.filter((s) => s.type === "farmer").slice(0, 2),
  ].slice(0, 10);
  const advanceSupplierIds = new Set(advanceSuppliers.map((s) => s.id));
  const advancesByDay = new Map<number, Array<{ supplier: SupplierRef; amountKobo: Kobo; offset: "full" | "part" | null; offsetDay: number }>>();
  advanceSuppliers.forEach((s, i) => {
    const day = rng.int(0, 40);
    const offset = i < 7 ? (rng.chance(0.6) ? "full" : "part") : null;
    push(advancesByDay, day, {
      supplier: s,
      amountKobo: rng.int(10, 60) * 1_000_000,
      offset,
      offsetDay: Math.min(LAST - 1, day + rng.int(15, 35)),
    });
  });
  const offsetsByDay = new Map<number, Array<{ advanceId: string; mode: "full" | "part"; amountKobo: Kobo }>>();

  // ── purchase plans ───────────────────────────────────────────────────────
  const supplierWeight = (s: SupplierRef) =>
    (s.type === "cooperative" ? 3 : s.type === "agent" ? 2.5 : 1) + (advanceSupplierIds.has(s.id) ? 1.5 : 0);
  const plans: PurchasePlan[] = [];
  for (let i = 0; i < N_PURCHASES; i++) {
    const day = Math.floor((i * LAST) / N_PURCHASES); // 0..89
    const supplier = rng.weighted(suppliers, supplierWeight);
    const bp: BuyingPointKey = rng.chance(0.85) ? supplier.bp : rng.pick(BUYING_POINTS).key;
    const overGuide = OVER_GUIDE_APPROVED.has(i) || OVER_GUIDE_PENDING.has(i);
    const nLines = overGuide ? rng.int(1, 2) : rng.weighted([1, 2, 3], (n) => (n === 1 ? 50 : n === 2 ? 35 : 15));
    const used = new Set<string>();
    const lines: LinePlan[] = [];
    const date = cal.date(day);
    for (let l = 0; l < nLines; l++) {
      let code: CommodityCode;
      let grade: GradeKey;
      let tries = 0;
      do {
        if (overGuide && l === 0) {
          code = rng.chance(0.6) ? "MZ" : "SB";
          grade = "A";
        } else {
          const w = BP_COMMODITY_WEIGHTS[bp];
          code = rng.weighted(Object.keys(w) as CommodityCode[], (c) => w[c]);
          grade = rng.chance(0.65) ? "A" : "B";
        }
        tries++;
      } while (used.has(`${code}${grade}`) && tries < 20);
      if (used.has(`${code}${grade}`)) continue;
      used.add(`${code}${grade}`);

      const spec = COMMODITIES.find((c) => c.code === code)!;
      const bag = BAG_TYPES.find((b) => b.key === spec.bag)!;
      const bags = spec.bag === "100" ? rng.int(8, 48) : rng.int(10, 60);
      const perBag = Number(bag.standardKg) + Number(bag.sackWeightKg) + rng.float(-1.5, 2.5) * (spec.bag === "100" ? 1 : 0.5);
      const gross = bags * perBag;
      const moisture = rng.float(11, 16.5);
      const deductions: LinePlan["deductions"] = [];
      if (moisture > 13.5) {
        deductions.push({ reason: "moisture", kg: kgStr((gross * (moisture - 13.5)) / 100), note: "above 13.5% standard" });
      }
      if (rng.chance(0.6)) {
        deductions.push({ reason: "foreign_matter", kg: kgStr(gross * rng.float(0.003, 0.015)), note: null });
      }
      const guide = spec.guided ? guideFor(m, code, bp, date) : null;
      let price: Kobo;
      if (overGuide && l === 0 && guide !== null) {
        price = Math.ceil((guide * rng.float(1.02, 1.05)) / 100) * 100;
      } else if (guide !== null) {
        price = Math.floor((guide * gradeFactor(grade) * rng.float(0.9, 0.985)) / 100) * 100;
      } else {
        price = round100(spec.baseBuyKobo * priceIndex(day) * gradeFactor(grade) * rng.float(0.95, 1.03));
      }
      lines.push({
        code,
        grade,
        bags,
        grossKg: kgStr(gross),
        moisturePercent: moisture.toFixed(1),
        deductions,
        pricePerKgKobo: price,
      });
    }
    const lagRoll = rng.random();
    plans.push({
      idx: i,
      day,
      supplier,
      bp,
      lines,
      overGuide,
      keepPending: OVER_GUIDE_PENDING.has(i),
      lag: lagRoll < 0.4 ? 0 : lagRoll < 0.8 ? 1 : 2,
    });
  }
  const plansByDay = new Map<number, PurchasePlan[]>();
  for (const p of plans) push(plansByDay, p.day, p);

  // ── sales plans ──────────────────────────────────────────────────────────
  const salesByDay = new Map<number, number[]>();
  for (let j = 0; j < N_SALES; j++) push(salesByDay, 4 + Math.floor((j * (LAST - 4)) / (N_SALES - 1)), j);

  // ── queues ───────────────────────────────────────────────────────────────
  const approvalsByDay = new Map<number, Array<{ plan: PurchasePlan; id: string }>>();
  const receiptsByDay = new Map<number, Array<{ plan: PurchasePlan; id: string; totalKobo: Kobo }>>();
  const supplierPayByDay = new Map<number, SupplierPayDue[]>();
  const customerPayByDay = new Map<number, CustomerPayDue[]>();
  const deliveriesByDay = new Map<number, Array<{ dispatchId: string; dispatchedG: Grams }>>();
  const transferReceiptsByDay = new Map<number, string[]>();
  const adjustmentApprovalsByDay = new Map<number, string[]>();
  const received: ReceivedPurchase[] = [];
  const openDispatches: OpenDispatch[] = [];
  const invoiceTotals = new Map<string, Kobo>();
  const invoicePaid = new Map<string, Kobo>();
  let vehicleRot = 0;
  const nextVehicle = () => {
    const i = vehicleRot++ % m.vehicles.length;
    return { vehicleId: m.vehicles[i], driverId: m.drivers[i] };
  };

  // ── read helpers (reads are free; they mirror what the UI would show) ────
  async function lotBalances(warehouseId?: string): Promise<LotBalance[]> {
    const onHand = await db
      .select({
        lotId: stockMovements.lotId,
        warehouseId: stockMovements.warehouseId,
        kg: sql<string>`coalesce(sum(${stockMovements.kg}), 0)`,
        bags: sql<string>`coalesce(sum(${stockMovements.bags}), 0)`,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.organisationId, orgId),
          warehouseId ? eq(stockMovements.warehouseId, warehouseId) : undefined,
        ),
      )
      .groupBy(stockMovements.lotId, stockMovements.warehouseId);
    const reserved = await db
      .select({
        lotId: lotAllocations.lotId,
        warehouseId: lotAllocations.warehouseId,
        kg: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)`,
      })
      .from(lotAllocations)
      .where(and(eq(lotAllocations.organisationId, orgId), eq(lotAllocations.status, "reserved")))
      .groupBy(lotAllocations.lotId, lotAllocations.warehouseId);
    const lotRows = await db
      .select({ id: lots.id, originalKg: lots.originalKg, originalBags: lots.originalBags, receivedAt: lots.receivedAt })
      .from(lots)
      .where(eq(lots.organisationId, orgId));
    const lotMap = new Map(lotRows.map((l) => [l.id, l]));
    const resMap = new Map(reserved.map((r) => [`${r.lotId}|${r.warehouseId}`, kgToGrams(r.kg)]));
    return onHand
      .map((r) => {
        const lot = lotMap.get(r.lotId)!;
        const onHandG = kgToGrams(r.kg);
        const reservedG = resMap.get(`${r.lotId}|${r.warehouseId}`) ?? 0;
        return {
          lotId: r.lotId,
          warehouseId: r.warehouseId,
          onHandG,
          bags: Number(r.bags),
          reservedG,
          availG: onHandG - reservedG,
          originalG: kgToGrams(lot.originalKg),
          originalBags: lot.originalBags,
          receivedAt: lot.receivedAt,
        };
      })
      .filter((b) => b.onHandG > 0)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || (a.lotId < b.lotId ? -1 : 1));
  }

  async function availabilityByCommodityGrade(): Promise<Array<{ commodityId: string; gradeId: string; availG: Grams }>> {
    const onHand = await db
      .select({
        commodityId: lots.commodityId,
        gradeId: lots.gradeId,
        kg: sql<string>`coalesce(sum(${stockMovements.kg}), 0)`,
      })
      .from(stockMovements)
      .innerJoin(lots, eq(lots.id, stockMovements.lotId))
      .where(eq(stockMovements.organisationId, orgId))
      .groupBy(lots.commodityId, lots.gradeId);
    const reserved = await db
      .select({
        commodityId: lots.commodityId,
        gradeId: lots.gradeId,
        kg: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)`,
      })
      .from(lotAllocations)
      .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
      .where(and(eq(lotAllocations.organisationId, orgId), eq(lotAllocations.status, "reserved")))
      .groupBy(lots.commodityId, lots.gradeId);
    const res = new Map(reserved.map((r) => [`${r.commodityId}|${r.gradeId}`, kgToGrams(r.kg)]));
    return onHand.map((r) => ({
      commodityId: r.commodityId,
      gradeId: r.gradeId,
      availG: kgToGrams(r.kg) - (res.get(`${r.commodityId}|${r.gradeId}`) ?? 0),
    }));
  }

  // ── backdating (the only direct business-table writes) ───────────────────
  async function backdateMovements(refId: string, type: (typeof stockMovements.$inferSelect)["type"], at: Date) {
    await db
      .update(stockMovements)
      .set({ occurredAt: at, createdAt: at })
      .where(and(eq(stockMovements.organisationId, orgId), eq(stockMovements.refId, refId), eq(stockMovements.type, type)));
  }
  async function backdateAdjustment(adj: Adjustment, at: Date) {
    if (adj.status === "posted") {
      await db.update(adjustments).set({ createdAt: at, approvedAt: at, updatedAt: at }).where(eq(adjustments.id, adj.id));
      await backdateMovements(adj.id, "adjustment", at);
    } else {
      await db.update(adjustments).set({ createdAt: at, updatedAt: at }).where(eq(adjustments.id, adj.id));
    }
  }

  // ── event handlers ───────────────────────────────────────────────────────
  async function doAdvance(d: number, a: { supplier: SupplierRef; amountKobo: Kobo; offset: "full" | "part" | null; offsetDay: number }) {
    act(ctxs.procurement, "advance.write");
    const adv = await createAdvance(
      db,
      ctxs.procurement,
      advanceInput.parse({
        supplierId: a.supplier.id,
        amountKobo: a.amountKobo,
        advanceDate: cal.date(d),
        note: "Pre-season input advance",
      }),
    );
    bump("advances");
    if (a.offset) {
      push(offsetsByDay, a.offsetDay, {
        advanceId: adv.id,
        mode: a.offset,
        amountKobo: a.offset === "part" ? round100(a.amountKobo / 2) : a.amountKobo,
      });
    }
  }

  async function doOffset(d: number, o: { advanceId: string; mode: "full" | "part"; amountKobo: Kobo }) {
    act(ctxs.accountant, "supplier-payment.write");
    try {
      const res = await offsetAdvance(
        db,
        ctxs.accountant,
        offsetAdvanceInput.parse({ advanceId: o.advanceId, amountKobo: o.mode === "part" ? o.amountKobo : undefined }),
      );
      const at = cal.at(d, 15, 30);
      await db
        .update(supplierAdvanceOffsets)
        .set({ createdAt: at })
        .where(
          and(
            eq(supplierAdvanceOffsets.advanceId, o.advanceId),
            gte(supplierAdvanceOffsets.createdAt, runStartedAt),
          ),
        );
      bump("advanceOffsets");
      bump("advanceOffsetKobo", res.totalOffsetKobo);
    } catch (err) {
      if (err instanceof DomainError && err.code === "NOTHING_TO_OFFSET") {
        bump("advanceOffsetsSkipped");
        return;
      }
      throw err;
    }
  }

  async function doPurchase(p: PurchasePlan) {
    const ctx = creatorFor(p.bp);
    act(ctx, "purchase.create");
    const bp = m.buyingPoints[p.bp];
    const { purchase } = await createPurchase(
      db,
      ctx,
      purchaseCreateInput.parse({
        supplierId: p.supplier.id,
        buyingPointId: bp.id,
        purchaseDate: cal.date(p.day),
        lines: p.lines.map((l) => {
          const c = m.commodities[l.code];
          return {
            commodityId: c.id,
            gradeId: c.grades[l.grade],
            bagTypeId: m.bagTypes[c.bag],
            bags: l.bags,
            grossKg: l.grossKg,
            moisturePercent: l.moisturePercent,
            pricePerKgKobo: l.pricePerKgKobo,
            deductions: l.deductions,
          };
        }),
      }),
    );
    const createdAt = cal.at(p.day, 8, 0, p.idx * 4);
    await db.update(purchases).set({ createdAt, updatedAt: createdAt }).where(eq(purchases.id, purchase.id));
    bump("purchases");
    if (purchase.status === "pending_approval") {
      bump("purchasesOverGuide");
      if (!p.keepPending) push(approvalsByDay, p.day + 1, { plan: p, id: purchase.id });
    } else if (purchase.status === "approved") {
      if (p.overGuide) throw new Error(`seed bug: purchase ${p.idx} planned over guide but approved`);
      push(receiptsByDay, p.day + p.lag, { plan: p, id: purchase.id, totalKobo: purchase.totalAmountKobo });
    } else {
      throw new Error(`unexpected purchase status ${purchase.status}`);
    }
  }

  async function doApprove(d: number, a: { plan: PurchasePlan; id: string }) {
    act(ctxs.manager, "purchase.approve");
    const row = await approvePurchase(db, ctxs.manager, { id: a.id });
    const at = cal.at(d, 8, 30, a.plan.idx);
    await db.update(purchases).set({ approvedAt: at, updatedAt: at }).where(eq(purchases.id, a.id));
    bump("purchasesApproved");
    const recvDay = Math.min(a.plan.day + 2, d + (a.plan.lag > 0 ? 1 : 0));
    push(receiptsByDay, recvDay, { plan: a.plan, id: a.id, totalKobo: row.totalAmountKobo });
  }

  async function doReceive(d: number, r: { plan: PurchasePlan; id: string; totalKobo: Kobo }) {
    const ctx = receiverFor(r.plan.bp);
    act(ctx, "purchase.receive");
    const wh = warehouseFor(r.plan.bp);
    const binId = rng.chance(0.5) ? rng.pick(wh.bins) : null;
    const res = await receivePurchase(db, ctx, receivePurchaseInput.parse({ purchaseId: r.id, warehouseId: wh.id, binId }));
    const at = cal.at(d, 9, 0, r.plan.idx * 4);
    await db.update(purchases).set({ receivedAt: at, updatedAt: at }).where(eq(purchases.id, r.id));
    await db
      .update(lots)
      .set({ receivedAt: at, createdAt: at, updatedAt: at })
      .where(inArray(lots.id, res.lots.map((l) => l.id)));
    await backdateMovements(r.id, "receive", at);
    bump("receipts");
    bump("lots", res.lots.length);
    received.push({
      id: r.id,
      idx: r.plan.idx,
      day: r.plan.day,
      recvDay: d,
      bp: r.plan.bp,
      supplierId: r.plan.supplier.id,
      totalKobo: r.totalKobo,
      tripLinked: false,
    });
    // Supplier payment plan: ~80% paid in full, ~8% half, rest left owing.
    const roll = rng.random();
    if (roll < 0.8) {
      push(supplierPayByDay, r.plan.day + rng.int(3, 30), { purchaseId: r.id, supplierId: r.plan.supplier.id, fraction: 1 });
    } else if (roll < 0.88) {
      push(supplierPayByDay, r.plan.day + rng.int(5, 20), { purchaseId: r.id, supplierId: r.plan.supplier.id, fraction: 0.5 });
    }
  }

  async function doSupplierPayments(d: number, due: SupplierPayDue[]) {
    act(ctxs.accountant, "supplier-payment.write");
    const bySupplier = new Map<string, SupplierPayDue[]>();
    for (const x of due) push(bySupplier, x.supplierId, x);
    for (const [supplierId, items] of bySupplier) {
      const open = await listOpenPurchases(db, ctxs.accountant, { supplierId });
      const outstanding = new Map(open.map((o) => [o.id, o]));
      const allocations: Array<{ purchaseId: string; amountKobo: Kobo }> = [];
      for (const it of items) {
        const o = outstanding.get(it.purchaseId);
        if (!o || o.outstandingKobo <= 0) continue;
        const amt = it.fraction >= 1 ? o.outstandingKobo : Math.min(o.outstandingKobo, round100(o.totalKobo * it.fraction));
        if (amt > 0) allocations.push({ purchaseId: it.purchaseId, amountKobo: amt });
      }
      if (allocations.length === 0) {
        bump("supplierPaymentsSkipped");
        continue;
      }
      const amountKobo = allocations.reduce((s, a) => s + a.amountKobo, 0);
      const methodRoll = rng.random();
      await recordSupplierPayment(
        db,
        ctxs.accountant,
        supplierPaymentInput.parse({
          supplierId,
          amountKobo,
          method: methodRoll < 0.6 ? "transfer" : methodRoll < 0.9 ? "cash" : "pos",
          paymentDate: cal.date(d),
          reference: methodRoll < 0.6 ? `TRF${rng.digits(10)}` : null,
          note: null,
          mode: "manual",
          allocations,
        }),
      );
      bump("supplierPayments");
      bump("supplierPaidKobo", amountKobo);
    }
  }

  async function doInboundTrip(d: number) {
    const candidates = received.filter((r) => !r.tripLinked && r.recvDay > d - 7 && r.recvDay <= d);
    const byBp = new Map<BuyingPointKey, ReceivedPurchase[]>();
    for (const r of candidates) push(byBp, r.bp, r);
    const groups = [...byBp.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
    if (groups.length === 0) return;
    const group = groups[0].slice(0, 6);
    const bp = group[0].bp;
    const tripDay = Math.max(...group.map((g) => g.recvDay));
    act(ctxs.manager, "trip.write");
    const trip = await createTrip(
      db,
      ctxs.manager,
      tripInput.parse({
        direction: "inbound",
        ...nextVehicle(),
        origin: `${m.buyingPoints[bp].name} buying point`,
        destination: warehouseFor(bp).name,
        tripDate: cal.date(tripDay),
        costKobo: rng.int(8, 25) * 1_000_000,
        note: `Collection run, ${group.length} purchases`,
      }),
    );
    await linkPurchases(db, ctxs.manager, tripLinkPurchasesInput.parse({ tripId: trip.id, purchaseIds: group.map((g) => g.id) }));
    for (const g of group) g.tripLinked = true;
    bump("tripsInbound");
    act(ctxs.accountant, "expense.write");
    if (rng.chance(0.6)) {
      await createExpense(
        db,
        ctxs.accountant,
        expenseInput.parse({
          categoryId: m.categories.transport,
          amountKobo: rng.int(12, 40) * 100_000,
          expenseDate: cal.date(tripDay),
          tripId: trip.id,
          note: "Offloading labour at warehouse",
        }),
      );
      bump("expenses");
    }
    if (rng.chance(0.35)) {
      await createExpense(
        db,
        ctxs.accountant,
        expenseInput.parse({
          categoryId: m.categories.loading,
          amountKobo: rng.int(8, 20) * 100_000,
          expenseDate: cal.date(tripDay),
          tripId: trip.id,
          note: "Loading boys at buying point",
        }),
      );
      bump("expenses");
    }
  }

  async function doSale(d: number, j: number) {
    const avail = (await availabilityByCommodityGrade()).filter((a) => a.availG >= 1_500_000);
    if (avail.length === 0) {
      bump("salesSkippedNoStock");
      return;
    }
    const customer = rng.weighted(customers, (c) => c.weight);
    const nLines = rng.chance(0.25) && avail.length > 1 ? 2 : 1;
    const picked: typeof avail = [];
    for (let i = 0; i < nLines; i++) {
      const pool = avail.filter((a) => !picked.includes(a));
      if (pool.length === 0) break;
      picked.push(rng.weighted(pool, (a) => a.availG));
    }
    const lines = picked
      .map((a) => {
        const spec = specByCommodityId.get(a.commodityId)!;
        const grade = gradeKeyById.get(a.gradeId)!;
        const wantKg = rng.int(2_000, 12_000);
        const kg = Math.floor(Math.min(wantKg, (a.availG / 1000) * 0.6) / 50) * 50;
        const price = round100(spec.baseBuyKobo * priceIndex(d) * gradeFactor(grade) * rng.float(1.18, 1.3));
        return { commodityId: a.commodityId, gradeId: a.gradeId, kg: String(kg), pricePerKgKobo: price };
      })
      .filter((l) => Number(l.kg) >= 500);
    if (lines.length === 0) {
      bump("salesSkippedNoStock");
      return;
    }
    act(ctxs.sales, "sale.write");
    const order = await createSalesOrder(db, ctxs.sales, { customerId: customer.id, orderDate: cal.date(d), lines });
    await confirmSalesOrder(db, ctxs.sales, { id: order.id });
    bump("salesOrders");
    if (j >= N_SALES - 3) {
      bump("salesConfirmedOnly");
      return;
    }
    act(ctxs.sales, "sale.allocate");
    const allocs = await autoAllocateOrder(db, ctxs.sales, { salesOrderId: order.id });
    if (j >= N_SALES - 5) {
      bump("salesAllocatedOnly");
      return;
    }
    act(ctxs.sales, "dispatch.write");
    const dispatchedAt = cal.at(d, 14, 0, j * 3);
    const { dispatch } = await createDispatch(
      db,
      ctxs.sales,
      { salesOrderId: order.id, allocationIds: allocs.map((a) => a.id), ...nextVehicle(), dispatchedAt },
      noopDeps,
    );
    bump("dispatches");
    openDispatches.push({ id: dispatch.id, day: d, city: customer.city, linked: false });
    // The latest dispatches (day 81+) stay in transit: delivery not yet recorded.
    const deliverDay = d + rng.int(1, 2);
    if (deliverDay <= LAST && d < LAST - 9) push(deliveriesByDay, deliverDay, { dispatchId: dispatch.id, dispatchedG: kgToGrams(dispatch.dispatchedKg) });

    act(ctxs.sales, "invoice.write");
    const invoice = await createInvoiceFromDispatch(
      db,
      ctxs.sales,
      { dispatchId: dispatch.id, invoiceDate: cal.date(d), dueDate: cal.date(d + 30), applyTax: false },
      noopDeps,
    );
    bump("invoices");
    invoiceTotals.set(invoice.id, invoice.totalKobo);
    // Receivables plan: ~70% paid in full, ~15% part-paid, ~15% left unpaid.
    const roll = rng.random();
    if (roll < 0.7) {
      push(customerPayByDay, d + rng.int(3, 25), { invoiceId: invoice.id, customerId: customer.id, fraction: 1 });
    } else if (roll < 0.85) {
      push(customerPayByDay, d + rng.int(7, 25), { invoiceId: invoice.id, customerId: customer.id, fraction: rng.float(0.4, 0.7) });
    }
  }

  async function doDelivery(d: number, x: { dispatchId: string; dispatchedG: Grams }) {
    act(ctxs.warehouse, "dispatch.deliver");
    const lossG = rng.chance(0.45) ? Math.round(x.dispatchedG * rng.float(0.001, 0.005)) : 0;
    await recordDelivery(db, ctxs.warehouse, {
      dispatchId: x.dispatchId,
      deliveredKg: gramsToKg(x.dispatchedG - lossG),
      deliveredAt: cal.at(d, 11, 0),
    });
    bump("deliveries");
    if (lossG > 0) bump("deliveriesWithTransitLoss");
  }

  async function doCustomerPayment(d: number, p: CustomerPayDue) {
    act(ctxs.accountant, "customer-payment.write");
    const total = invoiceTotals.get(p.invoiceId) ?? 0;
    const outstanding = total - (invoicePaid.get(p.invoiceId) ?? 0);
    const amount = p.fraction >= 1 ? outstanding : Math.min(outstanding, round100(total * p.fraction));
    if (amount <= 0) return;
    const methodRoll = rng.random();
    await recordCustomerPayment(db, ctxs.accountant, {
      customerId: p.customerId,
      amountKobo: amount,
      method: methodRoll < 0.8 ? "transfer" : methodRoll < 0.9 ? "pos" : "cash",
      paymentDate: cal.date(d),
      reference: `NIP${rng.digits(12)}`,
      allocations: [{ invoiceId: p.invoiceId, amountKobo: amount }],
    });
    invoicePaid.set(p.invoiceId, (invoicePaid.get(p.invoiceId) ?? 0) + amount);
    bump("customerPayments");
    bump("customerPaidKobo", amount);
  }

  async function doOutboundTrip(d: number) {
    const candidates = openDispatches.filter((x) => !x.linked && x.day > d - 9 && x.day <= d);
    if (candidates.length === 0) return;
    const byCity = new Map<CustomerRef["city"], OpenDispatch[]>();
    for (const c of candidates) push(byCity, c.city, c);
    const group = [...byCity.values()].sort((a, b) => b.length - a.length)[0].slice(0, 4);
    const city = group[0].city;
    const [lo, hi] = HAULAGE_KOBO[city];
    act(ctxs.manager, "trip.write");
    const trip = await createTrip(
      db,
      ctxs.manager,
      tripInput.parse({
        direction: "outbound",
        ...nextVehicle(),
        origin: m.warehouses.main.name,
        destination: city,
        tripDate: cal.date(Math.min(...group.map((g) => g.day))),
        costKobo: round100(rng.float(lo, hi)),
        note: `Delivery run to ${city}`,
      }),
    );
    await linkDispatches(db, ctxs.manager, tripLinkDispatchesInput.parse({ tripId: trip.id, dispatchIds: group.map((g) => g.id) }));
    for (const g of group) g.linked = true;
    bump("tripsOutbound");
  }

  async function doTransfer(d: number, last: boolean) {
    const ctx = ctxs.warehouse;
    act(ctx, "transfer.write");
    const pool = (await lotBalances(m.warehouses.main.id)).filter((b) => b.availG >= 2_000_000);
    if (pool.length === 0) {
      bump("transfersSkipped");
      return;
    }
    const chosen = rng.shuffle(pool).slice(0, rng.int(1, 2));
    const lines = chosen.map((b) => {
      const kg = Math.floor(((b.availG / 1000) * rng.float(0.3, 0.5)) / 100) * 100;
      const perBagKg = b.originalBags > 0 ? b.originalG / 1000 / b.originalBags : 0;
      const bags = perBagKg > 0 ? Math.min(b.bags, Math.max(0, Math.round(kg / perBagKg))) : 0;
      return { lotId: b.lotId, kg: String(kg), bags };
    });
    const t = await createTransfer(
      db,
      ctx,
      createTransferInput.parse({ fromWarehouseId: m.warehouses.main.id, toWarehouseId: m.warehouses.billiri.id, lines }),
    );
    await dispatchTransfer(db, ctx, transferIdInput.parse({ transferId: t.id }));
    const at = cal.at(d, 8, 30);
    await db.update(transfers).set({ createdAt: at, dispatchedAt: at, updatedAt: at }).where(eq(transfers.id, t.id));
    await backdateMovements(t.id, "transfer_out", at);
    bump("transfers");
    if (last) {
      bump("transfersInTransit");
      return;
    }
    push(transferReceiptsByDay, d + 1, t.id);
  }

  async function doTransferReceipt(d: number, transferId: string) {
    const ctx = ctxs.manager; // the keeper is restricted to Gombe Main; Billiri is received by the manager
    act(ctx, "transfer.receive");
    const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId));
    const lines = await db.select().from(transferLines).where(eq(transferLines.transferId, t.id));
    const lossy = rng.chance(0.6);
    await receiveTransfer(
      db,
      ctx,
      receiveTransferInput.parse({
        transferId: t.id,
        lines: lines.map((l) => {
          const sentG = kgToGrams(l.kg);
          const lossG = lossy ? Math.round((sentG * rng.float(0.001, 0.004)) / 100) * 100 : 0;
          return {
            lineId: l.id,
            receivedKg: gramsToKg(sentG - lossG),
            receivedBags: l.bags,
            binId: rng.pick(m.warehouses.billiri.bins),
          };
        }),
      }),
    );
    const at = cal.at(d, 10, 0);
    await db.update(transfers).set({ receivedAt: at, updatedAt: at }).where(eq(transfers.id, t.id));
    await backdateMovements(t.id, "transfer_in", at);
    bump("transfersReceived");
    if (lossy) bump("transfersWithLoss");
  }

  async function doCount(d: number, whKey: "main" | "billiri", diffsKg: number[]) {
    const ctx = whKey === "main" ? ctxs.warehouse : ctxs.manager;
    const wh = m.warehouses[whKey];
    act(ctx, "count.write");
    const pool = (await lotBalances(wh.id)).filter((b) => b.reservedG === 0 && b.onHandG >= 1_000_000);
    if (pool.length < diffsKg.length) {
      bump("countsSkipped");
      return;
    }
    const chosen = rng.shuffle(pool).slice(0, diffsKg.length);
    const countedAt = cal.at(d, 16, 0);
    const c = await createCount(
      db,
      ctx,
      createCountInput.parse({
        warehouseId: wh.id,
        countedAt,
        lines: chosen.map((b, i) => ({
          lotId: b.lotId,
          binId: null,
          countedKg: gramsToKg(b.onHandG + kgToGrams(diffsKg[i])),
          countedBags: b.bags,
        })),
      }),
    );
    act(ctx, "count.post");
    const { adjustments: created } = await postCount(db, ctx, countIdInput.parse({ countId: c.id }));
    const postedAt = cal.at(d, 17, 0);
    await db.update(stockCounts).set({ createdAt: countedAt, postedAt, updatedAt: postedAt }).where(eq(stockCounts.id, c.id));
    for (const adj of created) {
      await backdateAdjustment(adj, postedAt);
      bump(adj.status === "posted" ? "adjustmentsPosted" : "adjustmentsPending");
    }
    bump("counts");
  }

  async function doManualAdjustment(
    d: number,
    whKey: "main" | "billiri",
    reason: "spoilage" | "shrinkage",
    kg: number,
    note: string,
  ) {
    const ctx = whKey === "main" ? ctxs.warehouse : ctxs.manager;
    const wh = m.warehouses[whKey];
    act(ctx, "adjustment.write");
    const pool = (await lotBalances(wh.id)).filter((b) => b.availG >= 1_000_000);
    if (pool.length === 0) {
      bump("adjustmentsSkipped");
      return;
    }
    const lot = rng.pick(pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)))); // older half
    const adj = await createAdjustment(
      db,
      ctx,
      createAdjustmentInput.parse({ lotId: lot.lotId, warehouseId: wh.id, binId: null, reason, kg: String(-kg), bags: 0, note }),
    );
    await backdateAdjustment(adj, cal.at(d, 12, 0));
    if (adj.status === "pending_approval") {
      push(adjustmentApprovalsByDay, d + 1, adj.id);
      bump("adjustmentsAwaitingApproval");
    } else {
      bump("adjustmentsPosted");
    }
  }

  async function doApproveAdjustment(d: number, id: string) {
    act(ctxs.manager, "adjustment.approve");
    const adj = await approveAdjustment(db, ctxs.manager, adjustmentIdInput.parse({ adjustmentId: id }));
    const at = cal.at(d, 9, 0);
    await db.update(adjustments).set({ approvedAt: at, updatedAt: at }).where(eq(adjustments.id, adj.id));
    await backdateMovements(adj.id, "adjustment", at);
    bump("adjustmentsApproved");
  }

  async function doExpenses(d: number) {
    const date = cal.date(d);
    const tomorrow = cal.date(d + 1);
    act(ctxs.accountant, "expense.write");
    const add = async (key: keyof Master["categories"], amountKobo: Kobo, attach: { warehouseId?: string; lotId?: string }, note: string) => {
      await createExpense(
        db,
        ctxs.accountant,
        expenseInput.parse({ categoryId: m.categories[key], amountKobo, expenseDate: date, ...attach, note }),
      );
      bump("expenses");
    };
    // Monthly storage (non-landed) on the last day of each month.
    if (tomorrow.slice(8, 10) === "01") {
      await add("storage", 15_000_000, { warehouseId: m.warehouses.main.id }, `Warehouse rent + security, ${date.slice(0, 7)}`);
      await add("storage", 8_500_000, { warehouseId: m.warehouses.billiri.id }, `Depot rent, ${date.slice(0, 7)}`);
    }
    // Fumigation on the 15th.
    if (date.slice(8, 10) === "15") {
      await add("fumigation", rng.int(50, 60) * 100_000, { warehouseId: m.warehouses.main.id }, "Phostoxin fumigation, whole store");
      await add("fumigation", rng.int(30, 40) * 100_000, { warehouseId: m.warehouses.billiri.id }, "Phostoxin fumigation, depot");
    }
    // A few lot-attached non-landed costs.
    if ([25, 50, 65, 80].includes(d)) {
      const pool = await lotBalances();
      if (pool.length > 0) {
        const lot = rng.pick(pool);
        const bagging = d === 50 || d === 80;
        await add(
          bagging ? "bagging" : "fumigation",
          rng.int(12, 30) * 100_000,
          { lotId: lot.lotId },
          bagging ? "Re-bagging torn sacks" : "Spot fumigation after weevil sighting",
        );
      }
    }
  }

  // ── the simulation ───────────────────────────────────────────────────────
  for (let d = 0; d <= LAST; d++) {
    for (const a of advancesByDay.get(d) ?? []) await doAdvance(d, a);
    for (const a of approvalsByDay.get(d) ?? []) await doApprove(d, a);
    for (const p of plansByDay.get(d) ?? []) await doPurchase(p);
    for (const r of receiptsByDay.get(d) ?? []) await doReceive(d, r);
    for (const o of offsetsByDay.get(d) ?? []) await doOffset(d, o);

    for (const id of transferReceiptsByDay.get(d) ?? []) await doTransferReceipt(d, id);
    for (const id of adjustmentApprovalsByDay.get(d) ?? []) await doApproveAdjustment(d, id);
    const ti = TRANSFER_DAYS.indexOf(d);
    if (ti >= 0) await doTransfer(d, ti === TRANSFER_DAYS.length - 1);
    if (d === 20) await doManualAdjustment(d, "main", "spoilage", 25, "Water damage from roof leak");
    if (d === 41) await doManualAdjustment(d, "main", "shrinkage", 38.5, "Moisture loss in storage");
    if (d === 55) await doManualAdjustment(d, "main", "spoilage", 120, "Weevil infestation, bottom row of stack");
    if (d === 70) await doManualAdjustment(d, "billiri", "shrinkage", 15, "Handling loss on restack");
    if (d === 30) await doCount(d, "main", [0, 0, 0, 0]);
    if (d === 60) await doCount(d, "billiri", [0, -12.5, 0]);
    if (d === 88) await doCount(d, "main", [0, -18.5, -95]);

    for (const j of salesByDay.get(d) ?? []) await doSale(d, j);
    for (const x of deliveriesByDay.get(d) ?? []) await doDelivery(d, x);
    for (const p of customerPayByDay.get(d) ?? []) await doCustomerPayment(d, p);
    const supDue = supplierPayByDay.get(d);
    if (supDue) await doSupplierPayments(d, supDue);

    if (d % 7 === 6 || d === LAST) await doInboundTrip(d);
    if (d % 9 === 8 || d === LAST) await doOutboundTrip(d);
    await doExpenses(d);

    if (d % 10 === 0 || d === LAST) {
      console.log(
        `  day ${String(d).padStart(2)} ${cal.date(d)}  purchases ${stats.purchases ?? 0}  receipts ${stats.receipts ?? 0}  sales ${stats.salesOrders ?? 0}  dispatches ${stats.dispatches ?? 0}`,
      );
    }
  }

  return stats;
}
