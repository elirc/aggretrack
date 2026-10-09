import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  auditLog,
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
import { DomainError } from "@/lib/domain/errors";
import { computeLineAmountKobo } from "@/lib/domain/weights";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import * as expensesSvc from "@/lib/services/expenses";
import { computeLandedBreakdown, landedRateString, recomputeLandedCost } from "@/lib/services/landedCost";
import { postMovements } from "@/lib/services/stockCore";
import * as tripsSvc from "@/lib/services/trips";
import { createCustomer, createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { expenseInput, expenseUpdateInput, tripInput, tripUpdateInput } from "@/lib/validation/logistics";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let mdA: TestMasterData;
let mdB: TestMasterData;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction((tx) => fn(tx as unknown as Tx));
async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

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
        bags: 0,
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
        lotNumber: `LOT-T-${++seq}`,
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
  md: TestMasterData;
  customerId: string;
  date: string;
  picks: { lotId: string; kg: string; price: number }[];
}): Promise<{ salesOrderId: string; dispatchId: string }> {
  const { org, md } = o;
  const at = new Date(`${o.date}T12:00:00Z`);
  const amounts = o.picks.map((p) => computeLineAmountKobo(kgToGrams(p.kg), p.price));
  const [so] = await db
    .insert(salesOrders)
    .values({
      organisationId: org.orgId,
      orderNumber: `SO-T-${++seq}`,
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
        commodityId: md.commodityId,
        gradeId: md.gradeId,
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
        warehouseId: md.warehouseId,
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
        warehouseId: md.warehouseId,
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

async function rate(lotId: string): Promise<string> {
  const [r] = await db.select({ v: lots.landedCostPerKgKobo }).from(lots).where(eq(lots.id, lotId));
  return r.v;
}

const trip = (cost: number, direction: "inbound" | "outbound" = "inbound") =>
  tripsSvc.createTrip(asDb(db), A.ctx, tripInput.parse({ direction, tripDate: "2026-09-15", costKobo: cost, origin: "Gombe", destination: "Kano" }));

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Landed A" });
  B = await createTestOrg(db, { name: "Landed B" });
  mdA = await createMasterData(db, A.ctx);
  mdB = await createMasterData(db, B.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("rate rounding", () => {
  it("divides once at the end, half-up at the 4th dp", () => {
    expect(landedRateString(30000, 60000, 600_000)).toBe("30100.0000");
    expect(landedRateString(100, 1, 3_000)).toBe("100.3333"); // 0.33333…
    expect(landedRateString(100, 2, 3_000)).toBe("100.6667"); // 0.66666… → up
    expect(landedRateString(100, 1, 20_000_000)).toBe("100.0001"); // 0.00005 → half-up
    expect(landedRateString(100, 5, 0)).toBe("100.0000"); // zero weight → price only
  });
});

describe("inbound trip sharing by weight (DoD)", () => {
  it("one trip cost 100000 kobo over lots 600/400 kg → shares 60000/40000 exactly", async () => {
    const sup = await createSupplier(db, A.ctx);
    const { purchaseId, lotIds } = await receivePurchase({
      org: A,
      md: mdA,
      supplierId: sup,
      date: "2026-09-15",
      lines: [
        { kg: "600.000", price: 30000 },
        { kg: "400.000", price: 30000 },
      ],
    });
    const tr = await trip(100000);
    expect(tr.tripNumber).toMatch(/^TRP-\d{4}-\d{5}$/);
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: tr.id, purchaseIds: [purchaseId] });

    const br = await computeLandedBreakdown(asDb(db), A.ctx, lotIds);
    expect(br.get(lotIds[0])!.tripShareKobo).toBe(60000);
    expect(br.get(lotIds[1])!.tripShareKobo).toBe(40000);
    expect(await rate(lotIds[0])).toBe("30100.0000");
    expect(await rate(lotIds[1])).toBe("30100.0000");

    // Odd total → largest remainder: 60000.6 / 40000.4 → the spare kobo goes to the 600 kg lot.
    await tripsSvc.updateTrip(
      asDb(db),
      A.ctx,
      tripUpdateInput.parse({ id: tr.id, tripDate: "2026-09-15", costKobo: 100001, origin: "Gombe", destination: "Kano" }),
    );
    const br2 = await computeLandedBreakdown(asDb(db), A.ctx, lotIds);
    expect(br2.get(lotIds[0])!.tripShareKobo).toBe(60001);
    expect(br2.get(lotIds[1])!.tripShareKobo).toBe(40000);
    expect(br2.get(lotIds[0])!.tripShareKobo + br2.get(lotIds[1])!.tripShareKobo).toBe(100001);
    expect(await rate(lotIds[0])).toBe("30100.0017"); // 60001 / 600 = 100.001666…
    expect(await rate(lotIds[1])).toBe("30100.0000");

    // Recompute wrote audit rows on the lots.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, "lots"), eq(auditLog.recordId, lotIds[0])));
    expect(audits.length).toBeGreaterThanOrEqual(2);

    // Unlinking the purchase drops the share: lots revert to the purchase price.
    await tripsSvc.unlinkPurchase(asDb(db), A.ctx, { tripId: tr.id, purchaseId });
    expect(await rate(lotIds[0])).toBe("30000.0000");
    expect(await rate(lotIds[1])).toBe("30000.0000");
  });

  it("pools trip cost + affecting trip expenses across lots of ALL purchases on the trip", async () => {
    const s1 = await createSupplier(db, A.ctx);
    const s2 = await createSupplier(db, A.ctx);
    const pa = await receivePurchase({ org: A, md: mdA, supplierId: s1, date: "2026-09-16", lines: [{ kg: "300.000", price: 25000 }] });
    const pb = await receivePurchase({ org: A, md: mdA, supplierId: s2, date: "2026-09-16", lines: [{ kg: "200.000", price: 25000 }] });
    const tr = await trip(50000);
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: tr.id, purchaseIds: [pa.purchaseId, pb.purchaseId] });
    // 50000 over 300/200 → 30000/20000 → +100/kg each.
    expect(await rate(pa.lotIds[0])).toBe("25100.0000");
    expect(await rate(pb.lotIds[0])).toBe("25100.0000");

    // Handling (affects landed cost) on the trip joins the pool: 50000 + 20001 = 70001.
    const exp = await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.handlingCategoryId, amountKobo: 20001, expenseDate: "2026-09-16", tripId: tr.id }),
    );
    expect(exp.expenseNumber).toMatch(/^EXP-\d{4}-\d{5}$/);
    const br = await computeLandedBreakdown(asDb(db), A.ctx, [pa.lotIds[0], pb.lotIds[0]]);
    expect(br.get(pa.lotIds[0])!.tripShareKobo).toBe(42001); // 42000.6 → +1
    expect(br.get(pb.lotIds[0])!.tripShareKobo).toBe(28000); // 28000.4
    expect(await rate(pa.lotIds[0])).toBe("25140.0033"); // 42001/300 = 140.00333…
    expect(await rate(pb.lotIds[0])).toBe("25140.0000");

    // A second inbound trip carrying purchase B only: B's lot sums both shares.
    const tr2 = await trip(10000);
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: tr2.id, purchaseIds: [pb.purchaseId] });
    expect(await rate(pb.lotIds[0])).toBe("25190.0000"); // (28000 + 10000)/200 = 190
    expect(await rate(pa.lotIds[0])).toBe("25140.0033");

    // A trip with expenses cannot be deleted; without, deletion recomputes its lots.
    await expectCode(tripsSvc.deleteTrip(asDb(db), A.ctx, tr.id), "IN_USE");
    await tripsSvc.deleteTrip(asDb(db), A.ctx, tr2.id);
    expect(await rate(pb.lotIds[0])).toBe("25140.0000");
  });

  it("direct lot expenses (affecting) add to that lot only; moving an expense recomputes both lots", async () => {
    const sup = await createSupplier(db, A.ctx);
    const p = await receivePurchase({
      org: A,
      md: mdA,
      supplierId: sup,
      date: "2026-09-17",
      lines: [
        { kg: "500.000", price: 20000 },
        { kg: "250.000", price: 20000 },
      ],
    });
    const [l1, l2] = p.lotIds;
    const e = await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.handlingCategoryId, amountKobo: 12345, expenseDate: "2026-09-17", lotId: l1 }),
    );
    expect(await rate(l1)).toBe("20024.6900"); // 12345 / 500
    expect(await rate(l2)).toBe("20000.0000");

    await expensesSvc.updateExpense(
      asDb(db),
      A.ctx,
      expenseUpdateInput.parse({ id: e.id, categoryId: mdA.handlingCategoryId, amountKobo: 12345, expenseDate: "2026-09-17", lotId: l2 }),
    );
    expect(await rate(l1)).toBe("20000.0000");
    expect(await rate(l2)).toBe("20049.3800"); // 12345 / 250

    await expensesSvc.deleteExpense(asDb(db), A.ctx, e.id);
    expect(await rate(l2)).toBe("20000.0000");
  });

  it("late-cost rule: a cost arriving after a sale updates the lot rate in place; invoice untouched", async () => {
    const sup = await createSupplier(db, A.ctx);
    const cus = await createCustomer(db, A.ctx);
    const p = await receivePurchase({ org: A, md: mdA, supplierId: sup, date: "2026-09-18", lines: [{ kg: "1000.000", price: 20000 }] });
    const lot = p.lotIds[0];
    const tr = await trip(500000);
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: tr.id, purchaseIds: [p.purchaseId] });
    expect(await rate(lot)).toBe("20500.0000");

    const sale = await dispatchSale({ org: A, md: mdA, customerId: cus, date: "2026-09-20", picks: [{ lotId: lot, kg: "600.000", price: 26000 }] });
    const [inv] = await db
      .insert(invoices)
      .values({
        organisationId: A.orgId,
        invoiceNumber: `INV-T-${++seq}`,
        customerId: cus,
        salesOrderId: sale.salesOrderId,
        dispatchId: sale.dispatchId,
        invoiceDate: "2026-09-20",
        subtotalKobo: 15_600_000,
        totalKobo: 15_600_000,
      })
      .returning();

    // Late handling bill on the trip after the sale.
    await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.handlingCategoryId, amountKobo: 250000, expenseDate: "2026-09-25", tripId: tr.id }),
    );
    expect(await rate(lot)).toBe("20750.0000");
    const [invAfter] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(invAfter.totalKobo).toBe(15_600_000);
  });

  it("non-affecting categories and outbound trips do nothing to landed cost", async () => {
    const sup = await createSupplier(db, A.ctx);
    const p = await receivePurchase({ org: A, md: mdA, supplierId: sup, date: "2026-09-19", lines: [{ kg: "100.000", price: 10000 }] });
    const lot = p.lotIds[0];
    const tr = await trip(0);
    await tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: tr.id, purchaseIds: [p.purchaseId] });
    expect(await rate(lot)).toBe("10000.0000");

    await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.storageCategoryId, amountKobo: 99999, expenseDate: "2026-09-19", lotId: lot }),
    );
    await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.storageCategoryId, amountKobo: 77777, expenseDate: "2026-09-19", tripId: tr.id }),
    );
    expect(await rate(lot)).toBe("10000.0000");

    // Outbound trip: affecting expense on it changes nothing; purchases cannot be linked.
    const out = await trip(40000, "outbound");
    await expectCode(tripsSvc.linkPurchases(asDb(db), A.ctx, { tripId: out.id, purchaseIds: [p.purchaseId] }), "TRIP_DIRECTION");
    await expensesSvc.createExpense(
      asDb(db),
      A.ctx,
      expenseInput.parse({ categoryId: mdA.handlingCategoryId, amountKobo: 5000, expenseDate: "2026-09-19", tripId: out.id }),
    );
    expect(await rate(lot)).toBe("10000.0000");
    // Recompute is idempotent: nothing changes → no writes reported.
    expect(await inTx((tx) => recomputeLandedCost(tx, A.ctx, [lot]))).toEqual([]);
  });

  it("validation + tenancy: one attachment only; org B cannot touch org A rows", async () => {
    expect(
      expenseInput.safeParse({
        categoryId: mdA.handlingCategoryId,
        amountKobo: 1,
        expenseDate: "2026-09-19",
        lotId: mdA.warehouseId,
        warehouseId: mdA.warehouseId,
      }).success,
    ).toBe(false);

    const sup = await createSupplier(db, A.ctx);
    const p = await receivePurchase({ org: A, md: mdA, supplierId: sup, date: "2026-09-19", lines: [{ kg: "10.000", price: 100 }] });
    const trA = await trip(1000);
    const trB = await tripsSvc.createTrip(asDb(db), B.ctx, tripInput.parse({ direction: "inbound", tripDate: "2026-09-19", costKobo: 1 }));
    await expectCode(tripsSvc.linkPurchases(asDb(db), B.ctx, { tripId: trB.id, purchaseIds: [p.purchaseId] }), "NOT_FOUND");
    await expectCode(tripsSvc.getTrip(asDb(db), B.ctx, trA.id), "NOT_FOUND");
    await expectCode(
      expensesSvc.createExpense(
        asDb(db),
        B.ctx,
        expenseInput.parse({ categoryId: mdB.handlingCategoryId, amountKobo: 1, expenseDate: "2026-09-19", lotId: p.lotIds[0] }),
      ),
      "NOT_FOUND",
    );
    expect((await tripsSvc.listTrips(asDb(db), B.ctx)).map((r) => r.id)).toEqual([trB.id]);
    expect(await expensesSvc.listExpenses(asDb(db), B.ctx)).toEqual([]);
  });
});
