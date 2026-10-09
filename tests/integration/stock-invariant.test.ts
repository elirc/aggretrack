import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import type { Db, DbOrTx } from "@/db/client";
import { lots, organisationSettings, purchaseLines, purchases, stockMovements, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { sumMovements } from "@/lib/domain/stock";
import { kgToGrams } from "@/lib/domain/units";
import { approveAdjustment, createAdjustment } from "@/lib/services/adjustments";
import { createCount, postCount } from "@/lib/services/counts";
import { postMovements } from "@/lib/services/stockCore";
import { getLotDetail, getStockPosition, onHandAt } from "@/lib/services/stockQueries";
import { createTransfer, dispatchTransfer, receiveTransfer } from "@/lib/services/transfers";
import {
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";

/**
 * DoD: stock on hand === Σ movements after EVERY flow, never negative; and an
 * outgoing-movement race on one lot lets exactly one transaction through.
 */

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;
let whB: string;
let supplierId: string;
let lotSeq = 0;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function seedLot(ctx: OrgContext, kg: string, warehouseId: string): Promise<string> {
  const n = ++lotSeq;
  const [p] = await db
    .insert(purchases)
    .values({
      organisationId: ctx.orgId,
      supplierId,
      officerId: ctx.userId,
      purchaseDate: "2026-10-01",
      status: "received",
    })
    .returning({ id: purchases.id });
  const [line] = await db
    .insert(purchaseLines)
    .values({
      purchaseId: p.id,
      organisationId: ctx.orgId,
      commodityId: md.commodityId,
      gradeId: md.gradeId,
      grossKg: kg,
      netKg: kg,
      pricePerKgKobo: 30_000,
      amountKobo: (kgToGrams(kg) * 30_000) / 1000,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: ctx.orgId,
      lotNumber: `LOT-I-${n}`,
      commodityId: md.commodityId,
      gradeId: md.gradeId,
      supplierId,
      purchaseLineId: line.id,
      receivedAt: new Date(),
      originalKg: kg,
      purchasePricePerKgKobo: 30_000,
      landedCostPerKgKobo: "30000.0000",
    })
    .returning({ id: lots.id });
  await (db as unknown as Db).transaction((tx) =>
    postMovements(tx, ctx, [
      { lotId: lot.id, warehouseId, type: "receive", grams: kgToGrams(kg), bags: 0, refType: "grn", refId: p.id },
    ]),
  );
  return lot.id;
}

/**
 * For every lot × warehouse: the service-reported on hand (stock position +
 * onHandAt + lot detail) equals the JS replay of the raw movement rows, and is
 * never negative.
 */
async function assertInvariant(step: string) {
  const raw = await db
    .select({ lotId: stockMovements.lotId, warehouseId: stockMovements.warehouseId, kg: stockMovements.kg })
    .from(stockMovements)
    .where(eq(stockMovements.organisationId, A.orgId));
  const replay = new Map<string, { kg: number }[]>();
  for (const r of raw) {
    const k = `${r.lotId}|${r.warehouseId}`;
    (replay.get(k) ?? replay.set(k, []).get(k)!).push({ kg: kgToGrams(r.kg) });
  }

  const pos = await getStockPosition(asDb(db), A.ctx);
  const posMap = new Map<string, number>();
  for (const c of pos.commodities)
    for (const g of c.grades)
      for (const w of g.warehouses) for (const l of w.lots) posMap.set(`${l.lotId}|${w.warehouseId}`, l.grams);

  for (const [key, mv] of replay) {
    const expected = sumMovements(mv);
    expect(expected, `${step}: negative on hand at ${key}`).toBeGreaterThanOrEqual(0);
    const [lotId, warehouseId] = key.split("|");
    const svc = await onHandAt(asDb(db), A.ctx, lotId, warehouseId);
    expect(svc.grams, `${step}: onHandAt ${key}`).toBe(expected);
    expect(posMap.get(key) ?? 0, `${step}: position ${key}`).toBe(expected);
    const detail = await getLotDetail(asDb(db), A.ctx, { lotId });
    const dw = detail.byWarehouse.find((w) => w.warehouseId === warehouseId);
    expect(dw?.grams ?? 0, `${step}: lot detail ${key}`).toBe(expected);
  }
  // No phantom position rows without movements.
  for (const key of posMap.keys()) expect(replay.has(key), `${step}: phantom ${key}`).toBe(true);

  // SQL-level cross-check: no lot × warehouse sum is negative.
  const neg = await db.execute(sql`
    select lot_id, warehouse_id, sum(kg) s from stock_movements
    where organisation_id = ${A.orgId} group by lot_id, warehouse_id having sum(kg) < 0
  `);
  expect((neg as unknown as { rows: unknown[] }).rows, `${step}: negative SQL sums`).toHaveLength(0);
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Invariant Org" });
  md = await createMasterData(db, A.ctx);
  const [w] = await db
    .insert(warehouses)
    .values({ organisationId: A.orgId, name: "Depot B", capacityKg: "100000.000" })
    .returning({ id: warehouses.id });
  whB = w.id;
  supplierId = await createSupplier(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("stock invariant: on hand === Σ movements after every flow", () => {
  it("receive → transfer → count-adjust → negative adjustment → dispatch → return", async () => {
    // 1. receive two lots
    const lot1 = await seedLot(A.ctx, "500", md.warehouseId);
    await assertInvariant("receive lot1");
    const lot2 = await seedLot(A.ctx, "120.250", md.warehouseId);
    await assertInvariant("receive lot2");

    // 2. transfer 200 kg of lot1 A→B, with 1.5 kg loss
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [
        { lotId: lot1, kg: "200", bags: 0 },
        { lotId: lot2, kg: "20.250", bags: 0 },
      ],
    });
    await assertInvariant("transfer draft");
    const sent = await dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id });
    await assertInvariant("transfer dispatch");
    const l1 = sent.lines.find((l) => l.lotId === lot1)!;
    const l2 = sent.lines.find((l) => l.lotId === lot2)!;
    await receiveTransfer(asDb(db), A.ctx, {
      transferId: tr.id,
      lines: [
        { lineId: l1.id, receivedKg: "198.5", binId: null },
        { lineId: l2.id, receivedKg: "20.250", binId: null },
      ],
    });
    await assertInvariant("transfer receive");
    expect((await onHandAt(asDb(db), A.ctx, lot1, md.warehouseId)).grams).toBe(300_000);
    expect((await onHandAt(asDb(db), A.ctx, lot1, whB)).grams).toBe(198_500);

    // 3. count at B: lot1 short by 8.5 kg (auto), lot2 surplus 60 kg (pending → approve)
    const c = await createCount(asDb(db), A.ctx, {
      warehouseId: whB,
      lines: [
        { lotId: lot1, binId: null, countedKg: "190", countedBags: null },
        { lotId: lot2, binId: null, countedKg: "80.250", countedBags: null },
      ],
    });
    const posted = await postCount(asDb(db), A.ctx, { countId: c.id });
    await assertInvariant("count post");
    const pending = posted.adjustments.find((a) => a.status === "pending_approval")!;
    expect(pending.lotId).toBe(lot2);
    await approveAdjustment(asDb(db), A.ctx, { adjustmentId: pending.id });
    await assertInvariant("count adjustment approve");

    // 4. negative manual adjustment at A; then one that would break the floor
    await createAdjustment(asDb(db), A.ctx, {
      lotId: lot2,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "spoilage",
      kg: "-40",
      bags: 0,
      note: null,
    });
    await assertInvariant("negative adjustment");
    // Above threshold → pending; approving it would take on hand below zero.
    const tooBig = await createAdjustment(asDb(db), A.ctx, {
      lotId: lot2,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "theft",
      kg: "-60.001",
      bags: 0,
      note: null,
    });
    expect(tooBig.status).toBe("pending_approval");
    await expect(approveAdjustment(asDb(db), A.ctx, { adjustmentId: tooBig.id })).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "INSUFFICIENT_STOCK",
    );
    await assertInvariant("rejected floor-breaking adjustment");

    // 5. dispatch 100 kg of lot1 from A, then a 25 kg return (via the stock spine)
    const refId = crypto.randomUUID();
    await (db as unknown as Db).transaction((tx) =>
      postMovements(tx, A.ctx, [
        { lotId: lot1, warehouseId: md.warehouseId, type: "dispatch", grams: -100_000, bags: 0, refType: "wb", refId },
      ]),
    );
    await assertInvariant("dispatch");
    await (db as unknown as Db).transaction((tx) =>
      postMovements(tx, A.ctx, [
        { lotId: lot1, warehouseId: md.warehouseId, type: "return", grams: 25_000, bags: 0, refType: "wb", refId },
      ]),
    );
    await assertInvariant("return");

    // Final expected balances.
    expect((await onHandAt(asDb(db), A.ctx, lot1, md.warehouseId)).grams).toBe(225_000);
    expect((await onHandAt(asDb(db), A.ctx, lot1, whB)).grams).toBe(190_000);
    expect((await onHandAt(asDb(db), A.ctx, lot2, md.warehouseId)).grams).toBe(60_000);
    expect((await onHandAt(asDb(db), A.ctx, lot2, whB)).grams).toBe(80_250);
  });
});

describe("concurrent outgoing movements on one lot", () => {
  let p1: ReturnType<typeof makeTestDb>;
  let p2: ReturnType<typeof makeTestDb>;

  beforeAll(() => {
    // Two independent pg Pools → two real connections racing.
    p1 = makeTestDb();
    p2 = makeTestDb();
  });
  afterAll(async () => {
    await p1.close();
    await p2.close();
  });

  for (let round = 1; round <= 3; round++) {
    it(`two parallel 80 kg transfer dispatches from a 100 kg lot → exactly one succeeds (round ${round})`, async () => {
      const lotId = await seedLot(A.ctx, "100", md.warehouseId);
      const mk = () =>
        createTransfer(asDb(db), A.ctx, {
          fromWarehouseId: md.warehouseId,
          toWarehouseId: whB,
          lines: [{ lotId, kg: "80", bags: 0 }],
        });
      const [t1, t2] = [await mk(), await mk()];
      const results = await Promise.allSettled([
        dispatchTransfer(asDb(p1.db), A.ctx, { transferId: t1.id }),
        dispatchTransfer(asDb(p2.db), A.ctx, { transferId: t2.id }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0].reason).toBeInstanceOf(DomainError);
      expect((failed[0].reason as DomainError).code).toBe("INSUFFICIENT_STOCK");
      expect((await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams).toBe(20_000);
      await assertInvariant(`transfer race ${round}`);
    });
  }

  it("two parallel −80 kg auto-posted adjustments on a 100 kg lot → exactly one succeeds", async () => {
    await db
      .update(organisationSettings)
      .set({ adjustmentApprovalThresholdKg: "100" })
      .where(eq(organisationSettings.organisationId, A.orgId));
    const lotId = await seedLot(A.ctx, "100", md.warehouseId);
    const input = {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "shrinkage" as const,
      kg: "-80",
      bags: 0,
      note: null,
    };
    const results = await Promise.allSettled([
      createAdjustment(asDb(p1.db), A.ctx, input),
      createAdjustment(asDb(p2.db), A.ctx, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as DomainError).code).toBe("INSUFFICIENT_STOCK");
    expect((await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams).toBe(20_000);
    await assertInvariant("adjustment race");
  });
});
