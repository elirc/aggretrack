import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  adjustments,
  customerPaymentAllocations,
  customerPayments,
  dispatchLines,
  dispatches,
  invoices,
  lotAllocations,
  lots,
  notifications,
  purchaseLineDeductions,
  purchaseLines,
  purchases,
  salesLines,
  salesOrders,
  supplierPaymentAllocations,
  supplierPayments,
  transferLines,
  transfers,
  warehouses,
} from "@/db/schema";
import { computeLineAmountKobo } from "@/lib/domain/weights";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { getDashboard, lagosPeriods } from "@/lib/services/dashboard";
import * as expensesSvc from "@/lib/services/expenses";
import * as reports from "@/lib/services/reports";
import { postMovements } from "@/lib/services/stockCore";
import * as tripsSvc from "@/lib/services/trips";
import { createCustomer, createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import {
  expenseInput,
  payablesAgeingReportInput,
  purchasesReportInput,
  receivablesAgeingReportInput,
  runReportInput,
  salesByCustomerReportInput,
  shrinkageReportInput,
  stockMovementsReportInput,
  stockPositionReportInput,
  supplierPerformanceReportInput,
  tripCostsReportInput,
  tripInput,
} from "@/lib/validation/logistics";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let W2: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction((tx) => fn(tx as unknown as Tx));
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

// ── fixtures (direct inserts + stockCore; no dependency on other P2 services) ──
let seq = 0;

type LineSpec = { kg: string; price: number; grossKg?: string; overGuide?: boolean; deductions?: { reason: "moisture" | "foreign_matter"; kg: string }[] };

async function insertPurchase(o: {
  supplierId: string;
  date: string;
  status: "received" | "approved" | "pending_approval";
  lines: LineSpec[];
}): Promise<{ purchaseId: string; lineIds: string[] }> {
  const amounts = o.lines.map((l) => computeLineAmountKobo(kgToGrams(l.kg), l.price));
  const [p] = await db
    .insert(purchases)
    .values({
      organisationId: A.orgId,
      purchaseNumber: `PO-T-${++seq}`,
      supplierId: o.supplierId,
      buyingPointId: md.buyingPointId,
      officerId: A.userId,
      purchaseDate: o.date,
      status: o.status,
      totalAmountKobo: amounts.reduce((a, b) => a + b, 0),
      receivedWarehouseId: o.status === "received" ? md.warehouseId : null,
      receivedAt: o.status === "received" ? at(o.date) : null,
    })
    .returning({ id: purchases.id });
  const lineIds: string[] = [];
  for (let i = 0; i < o.lines.length; i++) {
    const l = o.lines[i];
    const [pl] = await db
      .insert(purchaseLines)
      .values({
        purchaseId: p.id,
        organisationId: A.orgId,
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        grossKg: l.grossKg ?? l.kg,
        netKg: l.kg,
        pricePerKgKobo: l.price,
        amountKobo: amounts[i],
        overGuide: l.overGuide ?? false,
      })
      .returning({ id: purchaseLines.id });
    for (const d of l.deductions ?? []) {
      await db.insert(purchaseLineDeductions).values({ purchaseLineId: pl.id, organisationId: A.orgId, reason: d.reason, kg: d.kg });
    }
    lineIds.push(pl.id);
  }
  return { purchaseId: p.id, lineIds };
}

async function receivePurchase(supplierId: string, date: string, lines: LineSpec[]) {
  const { purchaseId, lineIds } = await insertPurchase({ supplierId, date, status: "received", lines });
  const lotIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const [lot] = await db
      .insert(lots)
      .values({
        organisationId: A.orgId,
        lotNumber: `LOT-T-${String(++seq).padStart(3, "0")}`,
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        supplierId,
        purchaseLineId: lineIds[i],
        receivedAt: at(date),
        originalKg: lines[i].kg,
        purchasePricePerKgKobo: lines[i].price,
        landedCostPerKgKobo: `${lines[i].price}.0000`,
      })
      .returning({ id: lots.id });
    lotIds.push(lot.id);
  }
  await inTx((tx) =>
    postMovements(
      tx,
      A.ctx,
      lotIds.map((lotId, i) => ({
        lotId,
        warehouseId: md.warehouseId,
        type: "receive" as const,
        grams: kgToGrams(lines[i].kg),
        bags: 0,
        refType: "grn" as const,
        refId: purchaseId,
        occurredAt: at(date),
      })),
    ),
  );
  return { purchaseId, lotIds };
}

async function dispatchSale(customerId: string, date: string, picks: { lotId: string; kg: string; price: number }[]) {
  const amounts = picks.map((p) => computeLineAmountKobo(kgToGrams(p.kg), p.price));
  const [so] = await db
    .insert(salesOrders)
    .values({
      organisationId: A.orgId,
      orderNumber: `SO-T-${++seq}`,
      customerId,
      orderDate: date,
      status: "dispatched",
      totalAmountKobo: amounts.reduce((a, b) => a + b, 0),
    })
    .returning({ id: salesOrders.id });
  const totalG = picks.reduce((s, p) => s + kgToGrams(p.kg), 0);
  const [d] = await db
    .insert(dispatches)
    .values({
      organisationId: A.orgId,
      waybillNumber: `WB-T-${++seq}`,
      salesOrderId: so.id,
      dispatchedKg: gramsToKg(totalG),
      dispatchedAt: at(date),
    })
    .returning({ id: dispatches.id });
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const [sl] = await db
      .insert(salesLines)
      .values({
        salesOrderId: so.id,
        organisationId: A.orgId,
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        kg: p.kg,
        pricePerKgKobo: p.price,
        amountKobo: amounts[i],
      })
      .returning({ id: salesLines.id });
    const [la] = await db
      .insert(lotAllocations)
      .values({ organisationId: A.orgId, salesLineId: sl.id, lotId: p.lotId, warehouseId: md.warehouseId, kg: p.kg, status: "dispatched" })
      .returning({ id: lotAllocations.id });
    await db.insert(dispatchLines).values({ dispatchId: d.id, organisationId: A.orgId, lotAllocationId: la.id, kg: p.kg });
  }
  await inTx((tx) =>
    postMovements(
      tx,
      A.ctx,
      picks.map((p) => ({
        lotId: p.lotId,
        warehouseId: md.warehouseId,
        type: "dispatch" as const,
        grams: -kgToGrams(p.kg),
        bags: 0,
        refType: "wb" as const,
        refId: d.id,
        occurredAt: at(date),
      })),
    ),
  );
  return { salesOrderId: so.id, dispatchId: d.id };
}

// ── scenario ─────────────────────────────────────────────────────────────────
let LA: string; // stock as-at lot
let LB: string; // shrinkage lot
let sAge: string;
let sPerf: string;
let cAge: string;
let cSales: string;
let tripPurchaseId: string;

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Reports A" });
  B = await createTestOrg(db, { name: "Reports B" });
  md = await createMasterData(db, A.ctx);
  const [w2] = await db
    .insert(warehouses)
    .values({ organisationId: A.orgId, name: "Second Warehouse", capacityKg: "100000.000" })
    .returning({ id: warehouses.id });
  W2 = w2.id;

  const sStock = await createSupplier(db, A.ctx, { name: "Stock Supplier" });
  sAge = await createSupplier(db, A.ctx, { name: "Ageing Supplier" });
  sPerf = await createSupplier(db, A.ctx, { name: "Perf Supplier" });
  cSales = await createCustomer(db, A.ctx, { name: "Sales Customer" });
  cAge = await createCustomer(db, A.ctx, { name: "Ageing Customer" });

  // Stock as-at: 1000 kg on 1 Aug, 400 kg dispatched 10 Sep.
  LA = (await receivePurchase(sStock, "2026-08-01", [{ kg: "1000.000", price: 20000 }])).lotIds[0];
  await dispatchSale(cSales, "2026-09-10", [{ lotId: LA, kg: "400.000", price: 25000 }]);

  // Shrinkage lot: 500 kg on 1 Sep.
  LB = (await receivePurchase(sStock, "2026-09-01", [{ kg: "500.000", price: 10000 }])).lotIds[0];
  // Posted spoilage adjustment −25 kg on 15 Sep.
  const [adj] = await db
    .insert(adjustments)
    .values({
      organisationId: A.orgId,
      adjustmentNumber: "ADJ-T-1",
      lotId: LB,
      warehouseId: md.warehouseId,
      reason: "spoilage",
      kg: "-25.000",
      status: "posted",
      approvedAt: at("2026-09-15"),
    })
    .returning({ id: adjustments.id });
  await inTx((tx) =>
    postMovements(tx, A.ctx, [
      { lotId: LB, warehouseId: md.warehouseId, type: "adjustment", grams: -25_000, bags: 0, refType: "adj", refId: adj.id, occurredAt: at("2026-09-15") },
    ]),
  );
  // Transfer 100 kg W1 → W2: out 16 Sep, received 98 kg on 17 Sep (loss 2 kg).
  const [trf] = await db
    .insert(transfers)
    .values({
      organisationId: A.orgId,
      transferNumber: "TRF-T-1",
      fromWarehouseId: md.warehouseId,
      toWarehouseId: W2,
      status: "received",
      dispatchedAt: at("2026-09-16"),
      receivedAt: at("2026-09-17"),
    })
    .returning({ id: transfers.id });
  await db.insert(transferLines).values({
    transferId: trf.id,
    organisationId: A.orgId,
    lotId: LB,
    kg: "100.000",
    receivedKg: "98.000",
    lossKg: "2.000",
  });
  await inTx((tx) =>
    postMovements(tx, A.ctx, [
      { lotId: LB, warehouseId: md.warehouseId, type: "transfer_out", grams: -100_000, bags: 0, refType: "trf", refId: trf.id, occurredAt: at("2026-09-16") },
    ]),
  );
  await inTx((tx) =>
    postMovements(tx, A.ctx, [
      { lotId: LB, warehouseId: W2, type: "transfer_in", grams: 98_000, bags: 0, refType: "trf", refId: trf.id, occurredAt: at("2026-09-17") },
    ]),
  );
  // Dispatch 50 kg on 18 Sep, delivered 48.5 kg on 19 Sep (transit loss 1.5 kg).
  const sale = await dispatchSale(cSales, "2026-09-18", [{ lotId: LB, kg: "50.000", price: 15000 }]);
  await db
    .update(dispatches)
    .set({ status: "delivered", deliveredKg: "48.500", transitLossKg: "1.500", deliveredAt: at("2026-09-19") })
    .where(eq(dispatches.id, sale.dispatchId));

  // Supplier performance: gross 1000 → net 950 (30 moisture + 20 foreign), plus an over-guide 500 kg line.
  await insertPurchase({
    supplierId: sPerf,
    date: "2026-09-20",
    status: "approved",
    lines: [
      {
        kg: "950.000",
        grossKg: "1000.000",
        price: 30000,
        deductions: [
          { reason: "moisture", kg: "30.000" },
          { reason: "foreign_matter", kg: "20.000" },
        ],
      },
    ],
  });
  await insertPurchase({
    supplierId: sPerf,
    date: "2026-09-21",
    status: "pending_approval",
    lines: [{ kg: "500.000", price: 36000, overGuide: true }],
  });

  // Payables ageing (as at 8 Oct): 18 / 49 / 90 / 91 days old.
  await receivePurchase(sAge, "2026-09-20", [{ kg: "100.000", price: 1000 }]); // 100,000
  const p49 = await receivePurchase(sAge, "2026-08-20", [{ kg: "200.000", price: 1000 }]); // 200,000
  await receivePurchase(sAge, "2026-07-10", [{ kg: "300.000", price: 1000 }]); // 300,000
  await receivePurchase(sAge, "2026-07-09", [{ kg: "400.000", price: 1000 }]); // 400,000
  const [pay1] = await db
    .insert(supplierPayments)
    .values({ organisationId: A.orgId, supplierId: sAge, paymentNumber: "SPM-T-1", amountKobo: 50_000, method: "cash", paymentDate: "2026-10-01" })
    .returning({ id: supplierPayments.id });
  await db.insert(supplierPaymentAllocations).values({ organisationId: A.orgId, paymentId: pay1.id, purchaseId: p49.purchaseId, amountKobo: 50_000 });
  // A payment dated AFTER the as-at date must be ignored.
  const [pay2] = await db
    .insert(supplierPayments)
    .values({ organisationId: A.orgId, supplierId: sAge, paymentNumber: "SPM-T-2", amountKobo: 70_000, method: "transfer", paymentDate: "2026-10-20" })
    .returning({ id: supplierPayments.id });
  await db.insert(supplierPaymentAllocations).values({ organisationId: A.orgId, paymentId: pay2.id, purchaseId: p49.purchaseId, amountKobo: 70_000 });

  // Receivables ageing (as at 8 Oct): 37 days (part paid) and 90 days; void ignored.
  const [so] = await db
    .insert(salesOrders)
    .values({ organisationId: A.orgId, orderNumber: "SO-AGE-1", customerId: cAge, orderDate: "2026-07-01", status: "completed" })
    .returning({ id: salesOrders.id });
  const inv = async (num: string, date: string, total: number, status: "issued" | "void" = "issued") =>
    (
      await db
        .insert(invoices)
        .values({ organisationId: A.orgId, invoiceNumber: num, customerId: cAge, salesOrderId: so.id, invoiceDate: date, subtotalKobo: total, totalKobo: total, status })
        .returning({ id: invoices.id })
    )[0].id;
  const i37 = await inv("INV-T-1", "2026-09-01", 500_000);
  await inv("INV-T-2", "2026-07-10", 1_000_000);
  await inv("INV-T-3", "2026-06-01", 9_999_999, "void");
  const [cp] = await db
    .insert(customerPayments)
    .values({ organisationId: A.orgId, customerId: cAge, paymentNumber: "CPM-T-1", amountKobo: 200_000, method: "transfer", paymentDate: "2026-09-15" })
    .returning({ id: customerPayments.id });
  await db.insert(customerPaymentAllocations).values({ organisationId: A.orgId, paymentId: cp.id, invoiceId: i37, amountKobo: 200_000 });

  // Trip costs: inbound 60,000 + 6,000 expense over a 600 kg purchase.
  tripPurchaseId = (await receivePurchase(sStock, "2026-09-25", [{ kg: "600.000", price: 5000 }])).purchaseId;
  const trip = await tripsSvc.createTrip(asDb(db), A.ctx, tripInput.parse({ direction: "inbound", tripDate: "2026-09-25", costKobo: 60_000 }));
  await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: trip.id, purchaseIds: [tripPurchaseId] });
  await expensesSvc.createExpense(
    asDb(db),
    A.ctx,
    expenseInput.parse({ categoryId: md.handlingCategoryId, amountKobo: 6_000, expenseDate: "2026-09-25", tripId: trip.id }),
  );

  // This week (Lagos week of Mon 5 Oct 2026): one purchase on 6 Oct.
  const sNow = await createSupplier(db, A.ctx, { name: "This Week Supplier" });
  await receivePurchase(sNow, "2026-10-06", [{ kg: "100.000", price: 500 }]); // 50,000

  await db.insert(notifications).values({ organisationId: A.orgId, type: "low_stock", title: "Low maize" });
});

afterAll(async () => {
  await t.close();
});

describe("stock position as at a date", () => {
  it("sums movements up to the date — an earlier date differs from the current position", async () => {
    const early = await reports.stockPositionReport(asDb(db), A.ctx, stockPositionReportInput.parse({ asAt: "2026-09-01" }));
    const now = await reports.stockPositionReport(asDb(db), A.ctx, stockPositionReportInput.parse({ asAt: "2026-10-08" }));
    const earlyA = early.rows.find((r) => r.lotId === LA)!;
    const nowA = now.rows.find((r) => r.lotId === LA)!;
    expect(earlyA.kg).toBe("1000.000");
    expect(earlyA.valueKobo).toBe(20_000_000);
    expect(nowA.kg).toBe("600.000");
    expect(nowA.valueKobo).toBe(12_000_000);

    // Shrinkage lot through the transfer: as at 16 Sep W1 holds 375, W2 nothing; as at 17 Sep W2 holds 98.
    const d16 = await reports.stockPositionReport(asDb(db), A.ctx, stockPositionReportInput.parse({ asAt: "2026-09-16" }));
    expect(d16.rows.filter((r) => r.lotId === LB).map((r) => [r.warehouseId, r.kg])).toEqual([[md.warehouseId, "375.000"]]);
    const d17 = await reports.stockPositionReport(asDb(db), A.ctx, stockPositionReportInput.parse({ asAt: "2026-09-17", warehouseId: W2 }));
    expect(d17.rows.map((r) => [r.lotId, r.kg])).toEqual([[LB, "98.000"]]);
    expect(now.totals).not.toBeNull();
    expect(now.columns.map((c) => c.key)).toContain("valueKobo");

    // Movement report sees the four LB movements in September.
    const mv = await reports.stockMovementsReport(
      asDb(db),
      A.ctx,
      stockMovementsReportInput.parse({ from: "2026-09-01", to: "2026-09-30", lotId: LB }),
    );
    expect(mv.rows.map((r) => r.type)).toEqual(["receive", "adjustment", "transfer_out", "transfer_in", "dispatch"]);
  });
});

describe("ageing", () => {
  it("places payables in bands by purchase date (30/31, 60/61, 90/91 boundaries) and ignores later payments", async () => {
    const rep = await reports.payablesAgeingReport(asDb(db), A.ctx, payablesAgeingReportInput.parse({ asAt: "2026-10-08", supplierId: sAge }));
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]).toMatchObject({
      partyName: "Ageing Supplier",
      items: 4,
      oldestDays: 91,
      d0_30: 100_000,
      d31_60: 150_000, // 200,000 − 50,000 paid on 1 Oct (the 20 Oct payment is after as-at)
      d61_90: 300_000, // exactly 90 days
      d90_plus: 400_000, // 91 days
      totalKobo: 950_000,
    });
    // As at 25 Oct the later payment counts too.
    const later = await reports.payablesAgeingReport(asDb(db), A.ctx, payablesAgeingReportInput.parse({ asAt: "2026-10-25", supplierId: sAge }));
    expect(later.rows[0].totalKobo).toBe(880_000);
  });

  it("places receivables in bands by invoice date; void invoices ignored", async () => {
    const rep = await reports.receivablesAgeingReport(
      asDb(db),
      A.ctx,
      receivablesAgeingReportInput.parse({ asAt: "2026-10-08", customerId: cAge }),
    );
    expect(rep.rows[0]).toMatchObject({ items: 2, d0_30: 0, d31_60: 300_000, d61_90: 1_000_000, d90_plus: 0, totalKobo: 1_300_000 });
    expect(rep.totals).toMatchObject({ partyName: "Total", totalKobo: 1_300_000 });
  });
});

describe("shrinkage and losses", () => {
  it("picks up a posted adjustment, a transfer loss and a delivery transit loss with values", async () => {
    const rep = await reports.shrinkageReport(asDb(db), A.ctx, shrinkageReportInput.parse({ from: "2026-09-01", to: "2026-09-30" }));
    const by = new Map(rep.rows.map((r) => [`${r.source}:${r.reason}`, r]));
    expect(by.get("adjustment:spoilage")).toMatchObject({ events: 1, lossKg: "25.000", lossValueKobo: 250_000 });
    expect(by.get("transfer_loss:in_transit")).toMatchObject({ events: 1, lossKg: "2.000", lossValueKobo: 20_000 });
    expect(by.get("transit_loss:delivery")).toMatchObject({ events: 1, lossKg: "1.500", lossValueKobo: 15_000 });
    expect(rep.totals).toMatchObject({ lossKg: "28.500", lossValueKobo: 285_000 });

    const august = await reports.shrinkageReport(asDb(db), A.ctx, shrinkageReportInput.parse({ from: "2026-08-01", to: "2026-08-31" }));
    expect(august.rows).toEqual([]);
  });
});

describe("supplier performance", () => {
  it("computes volume, weighted average deduction % and over-guide count", async () => {
    const rep = await reports.supplierPerformanceReport(
      asDb(db),
      A.ctx,
      supplierPerformanceReportInput.parse({ from: "2026-09-01", to: "2026-09-30", supplierId: sPerf }),
    );
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]).toMatchObject({
      purchases: 2,
      lines: 2,
      grossKg: "1500.000",
      netKg: "1450.000",
      deductionKg: "50.000",
      avgDeductionPercent: 3.33,
      moistureKg: "30.000",
      foreignMatterKg: "20.000",
      overGuideLines: 1,
      amountKobo: 950 * 30000 + 500 * 36000,
    });
  });
});

describe("other reports", () => {
  it("purchases by supplier/month, sales by customer, trip costs", async () => {
    const bySup = await reports.purchasesReport(
      asDb(db),
      A.ctx,
      purchasesReportInput.parse({ from: "2026-09-01", to: "2026-09-30", groupBy: "supplier", supplierId: sPerf }),
    );
    expect(bySup.rows).toEqual([
      expect.objectContaining({ groupLabel: "Perf Supplier", purchases: 2, netKg: "1450.000", amountKobo: 46_500_000 }),
    ]);
    const byMonth = await reports.purchasesReport(
      asDb(db),
      A.ctx,
      purchasesReportInput.parse({ from: "2026-07-01", to: "2026-10-31", groupBy: "month", supplierId: sAge }),
    );
    expect(byMonth.rows.map((r) => [r.groupKey, r.amountKobo])).toEqual([
      ["2026-07", 700_000],
      ["2026-08", 200_000],
      ["2026-09", 100_000],
    ]);

    const sales = await reports.salesByCustomerReport(
      asDb(db),
      A.ctx,
      salesByCustomerReportInput.parse({ from: "2026-09-01", to: "2026-09-30", customerId: cSales }),
    );
    expect(sales.rows[0]).toMatchObject({ orders: 2, orderedKg: "450.000", dispatchedKg: "450.000", orderValueKobo: 10_750_000, invoicedKobo: 0 });

    const trips = await reports.tripCostsReport(asDb(db), A.ctx, tripCostsReportInput.parse({ from: "2026-09-01", to: "2026-09-30" }));
    expect(trips.rows).toHaveLength(1);
    expect(trips.rows[0]).toMatchObject({ direction: "inbound", linkedDocs: 1, linkedKg: "600.000", costKobo: 60_000, expensesKobo: 6_000, totalKobo: 66_000, costPerKgKobo: 110 });
  });

  it("generic runner runs all ten reports; hidden prices strip money columns; org B sees nothing", async () => {
    const range = { from: "2026-07-01", to: "2026-10-31" };
    const inputs = [
      { report: "purchases", params: range },
      { report: "stock-position", params: { asAt: "2026-10-08" } },
      { report: "stock-movements", params: range },
      { report: "sales-by-customer", params: range },
      { report: "margin", params: { ...range, by: "lot" } },
      { report: "payables-ageing", params: { asAt: "2026-10-08" } },
      { report: "receivables-ageing", params: { asAt: "2026-10-08" } },
      { report: "supplier-performance", params: range },
      { report: "shrinkage", params: range },
      { report: "trip-costs", params: range },
    ];
    for (const raw of inputs) {
      const input = runReportInput.parse(raw);
      const res = await reports.runReport(asDb(db), A.ctx, input);
      expect(res.key).toBe(raw.report);
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.columns.length).toBeGreaterThan(0);
      const other = await reports.runReport(asDb(db), B.ctx, input);
      expect(other.rows).toEqual([]);
    }
    const hidden = await reports.stockPositionReport(
      asDb(db),
      { ...A.ctx, restrictions: { ...A.ctx.restrictions, hidePrices: true } },
      stockPositionReportInput.parse({ asAt: "2026-10-08" }),
    );
    expect(hidden.columns.some((c) => c.type === "kobo" || c.type === "rate")).toBe(false);
    expect(hidden.rows[0]).not.toHaveProperty("valueKobo");
    expect(runReportInput.safeParse({ report: "purchases", params: { from: "2026-10-01", to: "2026-09-01" } }).success).toBe(false);
  });
});

describe("dashboard", () => {
  it("aggregates in one call and agrees with the report bases", async () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(lagosPeriods(now)).toEqual({ today: "2026-10-08", weekStart: "2026-10-05", monthStart: "2026-10-01" });
    const d = await getDashboard(asDb(db), A.ctx, now);

    const pos = await reports.stockPositionReport(asDb(db), A.ctx, stockPositionReportInput.parse({ asAt: "2026-10-08" }));
    expect(d.stock.valueKobo).toBe(pos.totals!.valueKobo);
    expect(d.stock.kg).toBe(pos.totals!.kg);

    const pay = await reports.payablesAgeingReport(asDb(db), A.ctx, payablesAgeingReportInput.parse({ asAt: "2026-10-08" }));
    const rec = await reports.receivablesAgeingReport(asDb(db), A.ctx, receivablesAgeingReportInput.parse({ asAt: "2026-10-08" }));
    expect(d.owedToSuppliersKobo).toBe(pay.totals!.totalKobo);
    expect(d.owedByCustomersKobo).toBe(1_300_000);
    expect(rec.totals!.totalKobo).toBe(1_300_000);

    expect(d.purchases).toMatchObject({ weekKobo: 50_000, monthKobo: 50_000, weekKg: "100.000" });
    expect(d.sales.monthKobo).toBe(0);
    expect(d.grossMarginMonth).toMatchObject({ revenueKobo: 0, marginKobo: 0 });
    expect(d.pendingApprovals).toEqual({ purchases: 1, adjustments: 0, total: 1 });
    expect(d.unreadAlerts).toBe(1);
    expect(d.topSuppliers.length).toBeGreaterThan(0);
    expect(d.topSuppliers.length).toBeLessThanOrEqual(5);
    expect(d.topSuppliers[0].name).toBe("Perf Supplier"); // 46.5M in the 90-day window
    expect(d.topCustomers[0].name).toBe("Sales Customer");

    const hidden = await getDashboard(asDb(db), { ...A.ctx, restrictions: { ...A.ctx.restrictions, hidePrices: true } }, now);
    expect(hidden.stock.valueKobo).toBeNull();
    expect(hidden.owedToSuppliersKobo).toBeNull();
    expect(hidden.stock.kg).toBe(d.stock.kg);

    const other = await getDashboard(asDb(db), B.ctx, now);
    expect(other.stock.kg).toBe("0.000");
    expect(other.unreadAlerts).toBe(0);
  });
});
