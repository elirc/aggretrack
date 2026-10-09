import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { supplierAdvanceOffsets, supplierPaymentAllocations, supplierPayments } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { QUEUES } from "@/lib/jobs";
import * as advances from "@/lib/services/advances";
import { lagosYear } from "@/lib/services/numbering";
import { listOpenPurchases } from "@/lib/services/payables";
import * as purchasesSvc from "@/lib/services/purchases";
import { receivePurchase } from "@/lib/services/receiving";
import * as pay from "@/lib/services/supplierPayments";
import * as suppliersSvc from "@/lib/services/suppliers";
import { createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import {
  advanceInput,
  purchaseCreateInput,
  receivePurchaseInput,
  supplierPaymentInput,
} from "@/lib/validation/buying";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;
let supplierId: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const YEAR = lagosYear();

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

/** A received purchase worth exactly `totalKobo` (1 kobo/kg × grams… kept simple: price 1000 kobo/kg). */
async function receivedPurchase(purchaseDate: string, totalKobo: number, opts: { receive?: boolean; supplier?: string } = {}) {
  const kg = String(totalKobo / 1000);
  const { purchase } = await purchasesSvc.createPurchase(
    asDb(db),
    A.ctx,
    purchaseCreateInput.parse({
      supplierId: opts.supplier ?? supplierId,
      buyingPointId: md.buyingPointId,
      purchaseDate,
      lines: [{ commodityId: md.commodityId, gradeId: md.gradeId, grossKg: kg, pricePerKgKobo: 1000 }],
    }),
  );
  expect(purchase.totalAmountKobo).toBe(totalKobo);
  if (opts.receive !== false) {
    await receivePurchase(asDb(db), A.ctx, receivePurchaseInput.parse({ purchaseId: purchase.id, warehouseId: md.warehouseId }));
  }
  return purchase.id;
}

const payment = (over: Record<string, unknown>) =>
  supplierPaymentInput.parse({ supplierId, method: "transfer", paymentDate: "2026-10-06", ...over });

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  A = await createTestOrg(db);
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("FIFO allocation", () => {
  it("pays the oldest received purchase first, partial last, leftover unallocated", async () => {
    // created out of date order on purpose
    const p2 = await receivedPurchase("2026-09-10", 200_000);
    const p3 = await receivedPurchase("2026-09-20", 50_000);
    const p1 = await receivedPurchase("2026-09-01", 100_000);
    await receivedPurchase("2026-08-01", 70_000, { receive: false }); // approved, not received → not payable

    const r1 = await pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 250_000 }));
    expect(r1.payment.paymentNumber).toBe(`SPM-${YEAR}-00001`);
    expect(r1.allocations).toEqual([
      { purchaseId: p1, amountKobo: 100_000 },
      { purchaseId: p2, amountKobo: 150_000 },
    ]);
    expect(r1.unallocatedKobo).toBe(0);
    expect(r1.jobs).toEqual([]);

    const r2 = await pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 120_000, sendSms: true }));
    expect(r2.payment.paymentNumber).toBe(`SPM-${YEAR}-00002`);
    expect(r2.allocations).toEqual([
      { purchaseId: p2, amountKobo: 50_000 },
      { purchaseId: p3, amountKobo: 50_000 },
    ]);
    expect(r2.unallocatedKobo).toBe(20_000);
    expect(r2.jobs).toHaveLength(1);
    const sms = r2.jobs[0];
    expect(sms.name).toBe(QUEUES.SMS_SEND);
    if (sms.name === QUEUES.SMS_SEND) {
      expect(sms.data.body).toContain("₦1,200.00");
      expect(sms.data.body).toContain(r2.payment.paymentNumber);
    }

    expect(await listOpenPurchases(asDb(db), A.ctx, { supplierId })).toEqual([]);
    const bal = await suppliersSvc.getSupplierBalance(asDb(db), A.ctx, supplierId);
    expect(bal).toEqual({
      owedToSupplierKobo: 0,
      owedBySupplierKobo: 0,
      unallocatedPaymentsKobo: 20_000,
      netKobo: -20_000,
    });
  });

  it("concurrent payments never over-allocate one purchase (row locks)", async () => {
    const p1 = await receivedPurchase("2026-09-01", 100_000);
    const results = await Promise.all([
      pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 80_000 })),
      pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 80_000 })),
    ]);
    const [{ total }] = await db
      .select({ total: sql<string>`coalesce(sum(${supplierPaymentAllocations.amountKobo}), 0)` })
      .from(supplierPaymentAllocations)
      .where(eq(supplierPaymentAllocations.purchaseId, p1));
    expect(Number(total)).toBe(100_000);
    expect(results.map((r) => r.unallocatedKobo).sort((a, b) => a - b)).toEqual([0, 60_000]);
  });
});

describe("manual allocation", () => {
  it("accepts valid picks and rejects invalid ones without writing", async () => {
    const p1 = await receivedPurchase("2026-09-01", 100_000);
    const p2 = await receivedPurchase("2026-09-05", 40_000);
    const unreceived = await receivedPurchase("2026-09-06", 10_000, { receive: false });
    const otherSupplier = await createSupplier(db, A.ctx);
    const foreign = await receivedPurchase("2026-09-02", 10_000, { supplier: otherSupplier });

    const ok = await pay.recordSupplierPayment(
      asDb(db),
      A.ctx,
      payment({ amountKobo: 50_000, mode: "manual", allocations: [{ purchaseId: p2, amountKobo: 30_000 }] }),
    );
    expect(ok.allocations).toEqual([{ purchaseId: p2, amountKobo: 30_000 }]);
    expect(ok.unallocatedKobo).toBe(20_000);

    const bad = [
      [{ purchaseId: p2, amountKobo: 10_001 }], // exceeds outstanding (10 000 left)
      [{ purchaseId: unreceived, amountKobo: 1_000 }], // not received → not open
      [{ purchaseId: foreign, amountKobo: 1_000 }], // another supplier's purchase
      [
        { purchaseId: p1, amountKobo: 45_000 },
        { purchaseId: p2, amountKobo: 10_000 },
      ], // Σ 55 000 > payment 50 000
    ];
    for (const allocations of bad) {
      await expectCode(
        pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 50_000, mode: "manual", allocations })),
        "PAYMENT_ALLOCATION_INVALID",
      );
    }
    expect(await db.select().from(supplierPayments).where(eq(supplierPayments.supplierId, supplierId))).toHaveLength(1);
    // failed attempts released their SPM numbers
    const next = await pay.recordSupplierPayment(asDb(db), A.ctx, payment({ amountKobo: 1_000 }));
    expect(next.payment.paymentNumber).toBe(`SPM-${YEAR}-00002`);
    expect(next.allocations).toEqual([{ purchaseId: p1, amountKobo: 1_000 }]);

    const detail = await pay.getSupplierPayment(asDb(db), A.ctx, ok.payment.id);
    expect(detail.allocatedKobo).toBe(30_000);
    expect(detail.unallocatedKobo).toBe(20_000);
  });
});

describe("advance offsets + balance", () => {
  it("offsets oldest purchase first, capped by advance and purchase outstanding", async () => {
    const adv = await advances.createAdvance(
      asDb(db),
      A.ctx,
      advanceInput.parse({ supplierId, amountKobo: 150_000, advanceDate: "2026-08-15", note: "seed money" }),
    );
    expect(adv.advanceNumber).toBe(`ADV-${YEAR}-00001`);

    // nothing received yet → nothing to offset
    await expectCode(pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id }), "NOTHING_TO_OFFSET");

    const p1 = await receivedPurchase("2026-09-01", 100_000);
    const p2 = await receivedPurchase("2026-09-10", 50_000);
    await pay.recordSupplierPayment(
      asDb(db),
      A.ctx,
      payment({ amountKobo: 30_000, mode: "manual", allocations: [{ purchaseId: p1, amountKobo: 30_000 }] }),
    );

    const o1 = await pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id });
    expect(o1.offsets).toEqual([
      { purchaseId: p1, amountKobo: 70_000 }, // capped by purchase outstanding (100k − 30k paid)
      { purchaseId: p2, amountKobo: 50_000 },
    ]);
    expect(o1.totalOffsetKobo).toBe(120_000);
    expect(o1.advanceOutstandingKobo).toBe(30_000);
    await expectCode(pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id }), "NOTHING_TO_OFFSET");

    const p3 = await receivedPurchase("2026-09-20", 100_000);
    const o2 = await pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id, amountKobo: 10_000 }); // explicit cap
    expect(o2.offsets).toEqual([{ purchaseId: p3, amountKobo: 10_000 }]);
    expect(o2.advanceOutstandingKobo).toBe(20_000);

    const [advBal] = await advances.getAdvancesForSupplier(asDb(db), A.ctx, supplierId);
    expect(advBal).toMatchObject({ amountKobo: 150_000, offsetKobo: 130_000, outstandingKobo: 20_000 });

    // owed TO supplier = 250k received − 30k paid − 130k offset; owed BY = 150k − 130k
    expect(await suppliersSvc.getSupplierBalance(asDb(db), A.ctx, supplierId)).toEqual({
      owedToSupplierKobo: 90_000,
      owedBySupplierKobo: 20_000,
      unallocatedPaymentsKobo: 0,
      netKobo: 70_000,
    });

    // capped by the advance: asking for more than its outstanding recovers only 20k
    const o3 = await pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id, amountKobo: 999_999 });
    expect(o3.totalOffsetKobo).toBe(20_000);
    expect(o3.advanceOutstandingKobo).toBe(0);
    await expectCode(pay.offsetAdvance(asDb(db), A.ctx, { advanceId: adv.id }), "ADVANCE_FULLY_RECOVERED");
    expect(await db.select().from(supplierAdvanceOffsets)).toHaveLength(4);

    const listed = await advances.listAdvances(asDb(db), A.ctx, { outstandingOnly: true });
    expect(listed.total).toBe(0);

    const detail = await suppliersSvc.getSupplierDetail(asDb(db), A.ctx, supplierId);
    expect(detail.balance.owedToSupplierKobo).toBe(70_000);
    expect(detail.balance.owedBySupplierKobo).toBe(0);
    expect(detail.openPurchases.map((p) => [p.id, p.outstandingKobo])).toEqual([[p3, 70_000]]);
    expect(detail.advances[0].outstandingKobo).toBe(0);
    expect(detail.payments).toHaveLength(1);
    expect(detail.purchases).toHaveLength(3);

    // listSuppliers carries the same balance
    const list = await suppliersSvc.listSuppliers(asDb(db), A.ctx, {});
    expect(list.rows.find((r) => r.id === supplierId)?.balance.netKobo).toBe(70_000);
  });

  it("foreign-org supplier/advance ids are NOT_FOUND", async () => {
    const B = await createTestOrg(db);
    const adv = await advances.createAdvance(
      asDb(db),
      A.ctx,
      advanceInput.parse({ supplierId, amountKobo: 1_000, advanceDate: "2026-08-15" }),
    );
    await expectCode(pay.offsetAdvance(asDb(db), B.ctx, { advanceId: adv.id }), "NOT_FOUND");
    await expectCode(pay.recordSupplierPayment(asDb(db), B.ctx, payment({ amountKobo: 1_000 })), "NOT_FOUND");
    await expectCode(
      advances.createAdvance(asDb(db), B.ctx, advanceInput.parse({ supplierId, amountKobo: 1, advanceDate: "2026-08-15" })),
      "NOT_FOUND",
    );
  });
});

describe("supplier detail aggregate", () => {
  it("groups quality deductions by reason over time", async () => {
    for (const [date, moisture] of [
      ["2026-08-10", "2"],
      ["2026-08-20", "3"],
      ["2026-09-05", "1.5"],
    ] as const) {
      await purchasesSvc.createPurchase(
        asDb(db),
        A.ctx,
        purchaseCreateInput.parse({
          supplierId,
          buyingPointId: md.buyingPointId,
          purchaseDate: date,
          lines: [
            {
              commodityId: md.commodityId,
              gradeId: md.gradeId,
              bagTypeId: md.bagTypeId,
              bags: 1,
              grossKg: "100",
              pricePerKgKobo: 1000,
              deductions: [{ reason: "moisture", kg: moisture }],
            },
          ],
        }),
      );
    }
    const d = await suppliersSvc.getSupplierDetail(asDb(db), A.ctx, supplierId);
    expect(d.deductions.byPeriod).toEqual([
      { period: "2026-08", reason: "moisture", kg: "5.000" },
      { period: "2026-08", reason: "sack_weight", kg: "2.400" },
      { period: "2026-09", reason: "moisture", kg: "1.500" },
      { period: "2026-09", reason: "sack_weight", kg: "1.200" },
    ]);
    expect(Object.fromEntries(d.deductions.byReason.map((r) => [r.reason, r.kg]))).toEqual({
      moisture: "6.500",
      sack_weight: "3.600",
    });
    expect(d.deductions.grossKg).toBe("300.000");
    expect(d.purchases.map((p) => p.purchaseDate)).toEqual(["2026-09-05", "2026-08-20", "2026-08-10"]);
  });
});
