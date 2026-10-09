import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import { lagosToday, listPayables, payablesAgeing } from "@/lib/services/payables";
import * as purchasesSvc from "@/lib/services/purchases";
import { receivePurchase } from "@/lib/services/receiving";
import * as pay from "@/lib/services/supplierPayments";
import { createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { purchaseCreateInput, receivePurchaseInput, supplierPaymentInput } from "@/lib/validation/buying";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const AS_OF = "2026-06-30";

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Backdated purchase worth `totalKobo` (price 1000 kobo/kg), received unless told otherwise. */
async function purchase(supplierId: string, purchaseDate: string, totalKobo: number, receive = true) {
  const { purchase: p } = await purchasesSvc.createPurchase(
    asDb(db),
    A.ctx,
    purchaseCreateInput.parse({
      supplierId,
      buyingPointId: md.buyingPointId,
      purchaseDate,
      lines: [{ commodityId: md.commodityId, gradeId: md.gradeId, grossKg: String(totalKobo / 1000), pricePerKgKobo: 1000 }],
    }),
  );
  if (receive) {
    await receivePurchase(asDb(db), A.ctx, receivePurchaseInput.parse({ purchaseId: p.id, warehouseId: md.warehouseId }));
  }
  return p.id;
}

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  A = await createTestOrg(db);
  md = await createMasterData(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("payables ageing", () => {
  it("buckets outstanding by purchase-date age at the 30/31, 60/61, 90/91 boundaries", async () => {
    const s1 = await createSupplier(db, A.ctx, { name: "Alpha Farms" });
    const s2 = await createSupplier(db, A.ctx, { name: "Bravo Agent" });

    // s1: one purchase on each side of every boundary (distinct powers so sums are unambiguous)
    await purchase(s1, minusDays(AS_OF, 0), 1_000); // d0_30
    await purchase(s1, minusDays(AS_OF, 30), 2_000); // d0_30
    await purchase(s1, minusDays(AS_OF, 31), 4_000); // d31_60
    await purchase(s1, minusDays(AS_OF, 60), 8_000); // d31_60
    await purchase(s1, minusDays(AS_OF, 61), 16_000); // d61_90
    await purchase(s1, minusDays(AS_OF, 90), 32_000); // d61_90
    await purchase(s1, minusDays(AS_OF, 91), 64_000); // d90_plus
    await purchase(s1, minusDays(AS_OF, 200), 128_000); // d90_plus
    // excluded: future-dated relative to asOf, not received
    await purchase(s1, minusDays(AS_OF, -1), 256_000);
    await purchase(s1, minusDays(AS_OF, 10), 512_000, false);

    // s2: partially paid old purchase + fully paid one
    const old = await purchase(s2, minusDays(AS_OF, 45), 100_000);
    const paid = await purchase(s2, minusDays(AS_OF, 5), 50_000);
    await pay.recordSupplierPayment(
      asDb(db),
      A.ctx,
      supplierPaymentInput.parse({
        supplierId: s2,
        amountKobo: 90_000,
        method: "cash",
        paymentDate: AS_OF,
        mode: "manual",
        allocations: [
          { purchaseId: old, amountKobo: 40_000 },
          { purchaseId: paid, amountKobo: 50_000 },
        ],
      }),
    );

    const report = await payablesAgeing(asDb(db), A.ctx, { asOf: AS_OF });
    expect(report.asOf).toBe(AS_OF);
    const r1 = report.rows.find((r) => r.supplierId === s1)!;
    expect(r1.supplierName).toBe("Alpha Farms");
    expect(r1.bands).toEqual({ d0_30: 3_000, d31_60: 12_000, d61_90: 48_000, d90_plus: 192_000 });
    expect(r1.totalKobo).toBe(255_000);
    expect(r1.openPurchases).toBe(8);
    expect(r1.oldestDays).toBe(200);

    const r2 = report.rows.find((r) => r.supplierId === s2)!;
    expect(r2.bands).toEqual({ d0_30: 0, d31_60: 60_000, d61_90: 0, d90_plus: 0 });
    expect(r2.openPurchases).toBe(1);

    expect(report.rows.map((r) => r.supplierId)).toEqual([s1, s2]); // sorted by total owed desc
    expect(report.totals).toEqual({
      bands: { d0_30: 3_000, d31_60: 72_000, d61_90: 48_000, d90_plus: 192_000 },
      totalKobo: 315_000,
      openPurchases: 9,
    });

    // one day later the 30-day and 60-day and 90-day purchases each move up a band
    const later = await payablesAgeing(asDb(db), A.ctx, { asOf: minusDays(AS_OF, -1), supplierId: s1 });
    expect(later.rows).toHaveLength(1);
    expect(later.rows[0].bands).toEqual({
      d0_30: 1_000 + 256_000, // today's + the (now current) future purchase
      d31_60: 2_000 + 4_000,
      d61_90: 8_000 + 16_000,
      d90_plus: 32_000 + 64_000 + 128_000,
    });

    const flat = await listPayables(asDb(db), A.ctx, { asOf: AS_OF, supplierId: s2 });
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ id: old, outstandingKobo: 60_000, paidKobo: 40_000, ageDays: 45, band: "d31_60" });
  });

  it("is empty with nothing owed and defaults asOf to today in Lagos", async () => {
    const report = await payablesAgeing(asDb(db), A.ctx);
    expect(report.asOf).toBe(lagosToday());
    expect(report.rows).toEqual([]);
    expect(report.totals.totalKobo).toBe(0);
  });

  it("never shows another organisation's payables", async () => {
    const s1 = await createSupplier(db, A.ctx);
    await purchase(s1, AS_OF, 10_000);
    const B = await createTestOrg(db);
    const report = await payablesAgeing(asDb(db), B.ctx, { asOf: AS_OF });
    expect(report.rows).toEqual([]);
  });
});
