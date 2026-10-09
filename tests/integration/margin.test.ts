import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  dispatchLines,
  dispatches,
  invoices,
  lotAllocations,
  lots,
  purchaseLines,
  purchases,
  salesLines,
  salesOrders,
} from "@/db/schema";
import { computeLineAmountKobo } from "@/lib/domain/weights";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import * as expensesSvc from "@/lib/services/expenses";
import { lotMargin, marginByCommodity, marginByCustomer, marginByLot, marginBySale, saleMargin } from "@/lib/services/margin";
import { marginReport } from "@/lib/services/reports";
import { postMovements } from "@/lib/services/stockCore";
import { saleTrace, lotTrace } from "@/lib/services/traceability";
import * as tripsSvc from "@/lib/services/trips";
import { createCustomer, createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { expenseInput, marginReportInput, tripInput } from "@/lib/validation/logistics";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md1: TestMasterData; // commodity 1
let md2: TestMasterData; // commodity 2

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction((tx) => fn(tx as unknown as Tx));

// ── fixtures (direct inserts + stockCore; no dependency on other P2 services) ──
let seq = 0;

async function receivePurchase(o: {
  org: TestOrg;
  md: TestMasterData;
  supplierId: string;
  date: string;
  lines: { kg: string; price: number }[];
}): Promise<{ purchaseId: string; lotIds: string[] }> {
  const { org, md } = o;
  const receivedAt = new Date(`${o.date}T12:00:00Z`);
  const amounts = o.lines.map((l) => computeLineAmountKobo(kgToGrams(l.kg), l.price));
  const [p] = await db
    .insert(purchases)
    .values({
      organisationId: org.orgId,
      purchaseNumber: `PO-T-${++seq}`,
      supplierId: o.supplierId,
      buyingPointId: md.buyingPointId,
      officerId: org.userId,
      purchaseDate: o.date,
      status: "received",
      totalAmountKobo: amounts.reduce((a, b) => a + b, 0),
      receivedWarehouseId: md.warehouseId,
      receivedAt,
    })
    .returning({ id: purchases.id });
  const lotIds: string[] = [];
  for (let i = 0; i < o.lines.length; i++) {
    const l = o.lines[i];
    const [pl] = await db
      .insert(purchaseLines)
      .values({
        purchaseId: p.id,
        organisationId: org.orgId,
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        grossKg: l.kg,
        netKg: l.kg,
        pricePerKgKobo: l.price,
        amountKobo: amounts[i],
      })
      .returning({ id: purchaseLines.id });
    const [lot] = await db
      .insert(lots)
      .values({
        organisationId: org.orgId,
        lotNumber: `LOT-T-${String(++seq).padStart(3, "0")}`,
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        supplierId: o.supplierId,
        purchaseLineId: pl.id,
        receivedAt,
        originalKg: l.kg,
        purchasePricePerKgKobo: l.price,
        landedCostPerKgKobo: `${l.price}.0000`,
      })
      .returning({ id: lots.id });
    lotIds.push(lot.id);
  }
  await inTx((tx) =>
    postMovements(
      tx,
      org.ctx,
      lotIds.map((lotId, i) => ({
        lotId,
        warehouseId: md.warehouseId,
        type: "receive" as const,
        grams: kgToGrams(o.lines[i].kg),
        bags: 0,
        refType: "grn" as const,
        refId: p.id,
        occurredAt: receivedAt,
      })),
    ),
  );
  return { purchaseId: p.id, lotIds };
}

async function dispatchSale(o: {
  org: TestOrg;
  customerId: string;
  date: string;
  picks: { lotId: string; md: TestMasterData; kg: string; price: number }[];
}): Promise<{ salesOrderId: string; dispatchId: string }> {
  const { org } = o;
  const at = new Date(`${o.date}T12:00:00Z`);
  const amounts = o.picks.map((p) => computeLineAmountKobo(kgToGrams(p.kg), p.price));
  const [so] = await db
    .insert(salesOrders)
    .values({
      organisationId: org.orgId,
      orderNumber: `SO-T-${String(++seq).padStart(3, "0")}`,
      customerId: o.customerId,
      orderDate: o.date,
      status: "dispatched",
      totalAmountKobo: amounts.reduce((a, b) => a + b, 0),
    })
    .returning({ id: salesOrders.id });
  const totalG = o.picks.reduce((s, p) => s + kgToGrams(p.kg), 0);
  const [d] = await db
    .insert(dispatches)
    .values({
      organisationId: org.orgId,
      waybillNumber: `WB-T-${++seq}`,
      salesOrderId: so.id,
      dispatchedKg: gramsToKg(totalG),
      dispatchedAt: at,
    })
    .returning({ id: dispatches.id });
  for (let i = 0; i < o.picks.length; i++) {
    const p = o.picks[i];
    const [sl] = await db
      .insert(salesLines)
      .values({
        salesOrderId: so.id,
        organisationId: org.orgId,
        commodityId: p.md.commodityId,
        gradeId: p.md.gradeId,
        kg: p.kg,
        pricePerKgKobo: p.price,
        amountKobo: amounts[i],
      })
      .returning({ id: salesLines.id });
    const [la] = await db
      .insert(lotAllocations)
      .values({
        organisationId: org.orgId,
        salesLineId: sl.id,
        lotId: p.lotId,
        warehouseId: p.md.warehouseId,
        kg: p.kg,
        status: "dispatched",
      })
      .returning({ id: lotAllocations.id });
    await db.insert(dispatchLines).values({ dispatchId: d.id, organisationId: org.orgId, lotAllocationId: la.id, kg: p.kg });
  }
  await inTx((tx) =>
    postMovements(
      tx,
      org.ctx,
      o.picks.map((p) => ({
        lotId: p.lotId,
        warehouseId: p.md.warehouseId,
        type: "dispatch" as const,
        grams: -kgToGrams(p.kg),
        bags: 0,
        refType: "wb" as const,
        refId: d.id,
        occurredAt: at,
      })),
    ),
  );
  return { salesOrderId: so.id, dispatchId: d.id };
}

// ── scenario ─────────────────────────────────────────────────────────────────
let S1sup: string;
let S2sup: string;
let C1: string;
let C2: string;
let P1: { purchaseId: string; lotIds: string[] };
let L1: string;
let L2: string;
let sale1: string;
let sale2: string;
let sale3: string;
let invoiceId: string;

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Margin A" });
  B = await createTestOrg(db, { name: "Margin B" });
  md1 = await createMasterData(db, A.ctx);
  md2 = await createMasterData(db, A.ctx);
  S1sup = await createSupplier(db, A.ctx, { name: "Amina Farms" });
  S2sup = await createSupplier(db, A.ctx, { name: "Bello Coop" });
  C1 = await createCustomer(db, A.ctx, { name: "Kano Mills" });
  C2 = await createCustomer(db, A.ctx, { name: "Lagos Feeds" });

  P1 = await receivePurchase({ org: A, md: md1, supplierId: S1sup, date: "2026-08-10", lines: [{ kg: "1000.000", price: 20000 }] });
  L1 = P1.lotIds[0];
  L2 = (await receivePurchase({ org: A, md: md2, supplierId: S2sup, date: "2026-08-11", lines: [{ kg: "500.000", price: 18000 }] })).lotIds[0];

  sale1 = (await dispatchSale({ org: A, customerId: C1, date: "2026-09-05", picks: [{ lotId: L1, md: md1, kg: "400.000", price: 25000 }] })).salesOrderId;
  sale2 = (await dispatchSale({ org: A, customerId: C2, date: "2026-08-20", picks: [{ lotId: L1, md: md1, kg: "300.000", price: 26000 }] })).salesOrderId;
  sale3 = (
    await dispatchSale({
      org: A,
      customerId: C1,
      date: "2026-09-10",
      picks: [
        { lotId: L1, md: md1, kg: "100.000", price: 24000 },
        { lotId: L2, md: md2, kg: "200.000", price: 21000 },
      ],
    })
  ).salesOrderId;
  // A cancelled sale never counts.
  const cancelled = await dispatchSale({ org: A, customerId: C2, date: "2026-09-11", picks: [{ lotId: L2, md: md2, kg: "50.000", price: 99999 }] });
  await db.update(salesOrders).set({ status: "cancelled" }).where(eq(salesOrders.id, cancelled.salesOrderId));

  // Non-landed-cost expense attached to L1 (storage) → lot-margin expense.
  await expensesSvc.createExpense(
    asDb(db),
    A.ctx,
    expenseInput.parse({ categoryId: md1.storageCategoryId, amountKobo: 50_000, expenseDate: "2026-09-01", lotId: L1 }),
  );

  const [inv] = await db
    .insert(invoices)
    .values({
      organisationId: A.orgId,
      invoiceNumber: "INV-T-1",
      customerId: C1,
      salesOrderId: sale1,
      invoiceDate: "2026-09-05",
      subtotalKobo: 10_000_000,
      totalKobo: 10_000_000,
    })
    .returning({ id: invoices.id });
  invoiceId = inv.id;
});

afterAll(async () => {
  await t.close();
});

describe("margin math (DoD)", () => {
  it("per sale: revenue − landed cost", async () => {
    const rows = await marginBySale(asDb(db), A.ctx);
    const by = new Map(rows.map((r) => [r.salesOrderId, r]));
    expect(rows).toHaveLength(3); // cancelled excluded
    expect(by.get(sale1)).toMatchObject({
      dispatchedKg: "400.000",
      revenueKobo: 10_000_000,
      costKobo: 8_000_000,
      expensesKobo: 0,
      marginKobo: 2_000_000,
      marginPercent: 20,
      customerName: "Kano Mills",
    });
    expect(by.get(sale2)).toMatchObject({ revenueKobo: 7_800_000, costKobo: 6_000_000, marginKobo: 1_800_000 });
    expect(by.get(sale2)!.marginPercent).toBeCloseTo(23.0769, 3);
    // Multi-lot sale: 100 kg of L1 + 200 kg of L2.
    expect(by.get(sale3)).toMatchObject({
      dispatchedKg: "300.000",
      revenueKobo: 6_600_000,
      costKobo: 5_600_000,
      marginKobo: 1_000_000,
    });
  });

  it("per lot: dispatched revenue − dispatched g × landed rate − non-landed lot expenses", async () => {
    const rows = await marginByLot(asDb(db), A.ctx);
    const by = new Map(rows.map((r) => [r.lotId, r]));
    expect(by.get(L1)).toMatchObject({
      dispatchedKg: "800.000",
      revenueKobo: 20_200_000,
      costKobo: 16_000_000,
      expensesKobo: 50_000,
      marginKobo: 4_150_000,
      supplierName: "Amina Farms",
      landedCostPerKgKobo: "20000.0000",
    });
    expect(by.get(L2)).toMatchObject({ dispatchedKg: "200.000", revenueKobo: 4_200_000, costKobo: 3_600_000, marginKobo: 600_000 });
    expect((await lotMargin(asDb(db), A.ctx, L1))!.marginKobo).toBe(4_150_000);
  });

  it("per customer and per commodity are sums over their sales", async () => {
    const cust = new Map((await marginByCustomer(asDb(db), A.ctx)).map((r) => [r.customerId, r]));
    expect(cust.get(C1)).toMatchObject({ sales: 2, revenueKobo: 16_600_000, costKobo: 13_600_000, marginKobo: 3_000_000 });
    expect(cust.get(C2)).toMatchObject({ sales: 1, marginKobo: 1_800_000 });

    const com = new Map((await marginByCommodity(asDb(db), A.ctx)).map((r) => [r.commodityId, r]));
    expect(com.get(md1.commodityId)).toMatchObject({ sales: 3, revenueKobo: 20_200_000, costKobo: 16_000_000, marginKobo: 4_200_000 });
    expect(com.get(md2.commodityId)).toMatchObject({ sales: 1, marginKobo: 600_000 });
  });

  it("date range filters by dispatch date (Lagos)", async () => {
    const rows = await marginBySale(asDb(db), A.ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(rows.map((r) => r.salesOrderId).sort()).toEqual([sale1, sale3].sort());
    const rep = await marginReport(asDb(db), A.ctx, marginReportInput.parse({ from: "2026-09-01", to: "2026-09-30", by: "sale" }));
    expect(rep.rows).toHaveLength(2);
    expect(rep.totals).toMatchObject({ revenueKobo: 16_600_000, costKobo: 13_600_000, marginKobo: 3_000_000 });
    expect(rep.columns.map((c) => c.key)).toContain("marginPercent");
  });

  it("late cost: a trip cost arriving after the sales shifts margins; invoices unchanged", async () => {
    const trip = await tripsSvc.createTrip(
      asDb(db),
      A.ctx,
      tripInput.parse({ direction: "inbound", tripDate: "2026-08-10", costKobo: 1_000_000 }),
    );
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: trip.id, purchaseIds: [P1.purchaseId] });
    // 1,000,000 kobo over the single 1000 kg lot → +1000 kobo/kg.
    const [l] = await db.select({ v: lots.landedCostPerKgKobo }).from(lots).where(eq(lots.id, L1));
    expect(l.v).toBe("21000.0000");

    const s1 = await saleMargin(asDb(db), A.ctx, sale1);
    expect(s1).toMatchObject({ revenueKobo: 10_000_000, costKobo: 8_400_000, marginKobo: 1_600_000, marginPercent: 16 });
    const s3 = await saleMargin(asDb(db), A.ctx, sale3);
    expect(s3).toMatchObject({ costKobo: 2_100_000 + 3_600_000, marginKobo: 900_000 });
    const lot = await lotMargin(asDb(db), A.ctx, L1);
    expect(lot).toMatchObject({ costKobo: 16_800_000, expensesKobo: 50_000, marginKobo: 3_350_000 });

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.totalKobo).toBe(10_000_000);
    const [so] = await db.select().from(salesOrders).where(eq(salesOrders.id, sale1));
    expect(so.totalAmountKobo).toBe(10_000_000);
  });

  it("traceability: sale back to suppliers; lot forward to customers", async () => {
    const st = await saleTrace(asDb(db), A.ctx, sale3);
    expect(st.order.customerName).toBe("Kano Mills");
    expect(st.lines).toHaveLength(2);
    expect(st.suppliers.map((s) => [s.supplierName, s.dispatchedKg]).sort()).toEqual(
      [
        ["Amina Farms", "100.000"],
        ["Bello Coop", "200.000"],
      ].sort(),
    );
    const lt = await lotTrace(asDb(db), A.ctx, L1);
    expect(lt.supplier.name).toBe("Amina Farms");
    expect(lt.purchase.id).toBe(P1.purchaseId);
    expect(lt.movements.map((m) => m.type)).toEqual(["receive", "dispatch", "dispatch", "dispatch"]);
    expect(lt.lot.onHandKg).toBe("200.000");
    expect(new Map(lt.customers.map((c) => [c.customerName, c.kg]))).toEqual(
      new Map([
        ["Kano Mills", "500.000"],
        ["Lagos Feeds", "300.000"],
      ]),
    );
    // hidden prices strip rates
    const hidden = await lotTrace(asDb(db), { ...A.ctx, restrictions: { ...A.ctx.restrictions, hidePrices: true } }, L1);
    expect(hidden.lot.landedCostPerKgKobo).toBeNull();
    expect(hidden.purchaseLine.amountKobo).toBeNull();
  });

  it("tenancy: org B sees no margin rows", async () => {
    expect(await marginBySale(asDb(db), B.ctx)).toEqual([]);
    expect(await marginByLot(asDb(db), B.ctx)).toEqual([]);
    expect(await saleMargin(asDb(db), B.ctx, sale1)).toBeNull();
  });
});
