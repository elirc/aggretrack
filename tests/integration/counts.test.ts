import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "@/db/client";
import { adjustments, auditLog, lots, purchaseLines, purchases, stockMovements } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { approveAdjustment } from "@/lib/services/adjustments";
import { cancelCount, createCount, getCount, listCounts, postCount } from "@/lib/services/counts";
import { postMovements } from "@/lib/services/stockCore";
import { onHandAt } from "@/lib/services/stockQueries";
import {
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let supplierId: string;
let lotSeq = 0;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

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
      pricePerKgKobo: 20_000,
      amountKobo: (kgToGrams(kg) * 20_000) / 1000,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: ctx.orgId,
      lotNumber: `LOT-C-${n}`,
      commodityId: md.commodityId,
      gradeId: md.gradeId,
      supplierId,
      purchaseLineId: line.id,
      receivedAt: new Date(),
      originalKg: kg,
      purchasePricePerKgKobo: 20_000,
      landedCostPerKgKobo: "20000.0000",
    })
    .returning({ id: lots.id });
  await (db as unknown as Db).transaction((tx) =>
    postMovements(tx, ctx, [
      { lotId: lot.id, warehouseId, type: "receive", grams: kgToGrams(kg), bags: 0, refType: "grn", refId: p.id },
    ]),
  );
  return lot.id;
}

const onHand = async (lotId: string) => (await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams;

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Org A" });
  B = await createTestOrg(db, { name: "Org B" });
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("stock counts", () => {
  it("snapshots system kg and computes diff; posting creates adjustments by threshold", async () => {
    const shortLot = await seedLot(A.ctx, "200", md.warehouseId); // counted 190 → −10, auto
    const overLot = await seedLot(A.ctx, "200", md.warehouseId); // counted 300 → +100, pending
    const exactLot = await seedLot(A.ctx, "75.5", md.warehouseId); // counted equal → nothing
    const bigLossLot = await seedLot(A.ctx, "200", md.warehouseId); // counted 149.999 → −50.001, pending

    const c = await createCount(asDb(db), A.ctx, {
      warehouseId: md.warehouseId,
      lines: [
        { lotId: shortLot, binId: md.binId, countedKg: "190", countedBags: 19 },
        { lotId: overLot, binId: null, countedKg: "300", countedBags: null },
        { lotId: exactLot, binId: null, countedKg: "75.500", countedBags: null },
        { lotId: bigLossLot, binId: null, countedKg: "149.999", countedBags: null },
      ],
    });
    expect(c.status).toBe("draft");
    expect(c.countNumber).toMatch(/^CNT-\d{4}-\d{5}$/);
    const byLot = new Map(c.lines.map((l) => [l.lotId, l]));
    expect(byLot.get(shortLot)).toMatchObject({ systemKg: "200.000", countedKg: "190.000", diffKg: "-10.000" });
    expect(byLot.get(overLot)).toMatchObject({ systemKg: "200.000", diffKg: "100.000" });
    expect(byLot.get(exactLot)).toMatchObject({ systemKg: "75.500", diffKg: "0.000" });
    expect(byLot.get(bigLossLot)).toMatchObject({ diffKg: "-50.001" });
    // A draft count moves no stock.
    expect(await onHand(shortLot)).toBe(200_000);

    const { count: posted, adjustments: adjs } = await postCount(asDb(db), A.ctx, { countId: c.id });
    expect(posted.status).toBe("posted");
    expect(posted.postedAt).toBeInstanceOf(Date);
    expect(adjs).toHaveLength(3);
    const adjByLot = new Map(adjs.map((a) => [a.lotId, a]));
    expect(adjByLot.has(exactLot)).toBe(false);
    for (const a of adjs) {
      expect(a.reason).toBe("count_difference");
      expect(a.sourceCountId).toBe(c.id);
    }
    expect(adjByLot.get(shortLot)).toMatchObject({ status: "posted", kg: "-10.000", binId: md.binId });
    expect(adjByLot.get(overLot)).toMatchObject({ status: "pending_approval", kg: "100.000" });
    expect(adjByLot.get(bigLossLot)).toMatchObject({ status: "pending_approval", kg: "-50.001" });

    // Movements only for the posted adjustment.
    const mv = await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.organisationId, A.orgId), eq(stockMovements.type, "adjustment")));
    expect(mv.map((m) => m.refId)).toEqual([adjByLot.get(shortLot)!.id]);
    expect(await onHand(shortLot)).toBe(190_000);
    expect(await onHand(overLot)).toBe(200_000);
    expect(await onHand(exactLot)).toBe(75_500);
    expect(await onHand(bigLossLot)).toBe(200_000);

    await approveAdjustment(asDb(db), A.ctx, { adjustmentId: adjByLot.get(overLot)!.id });
    expect(await onHand(overLot)).toBe(300_000);

    // Can't post twice.
    await expectCode(postCount(asDb(db), A.ctx, { countId: c.id }), "INVALID_STATE");
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.organisationId, A.orgId), eq(auditLog.recordId, c.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["create", "post"]);
  });

  it("rejects duplicate lots and bins from another warehouse; cancel drafts", async () => {
    const lotId = await seedLot(A.ctx, "10", md.warehouseId);
    await expectCode(
      createCount(asDb(db), A.ctx, {
        warehouseId: md.warehouseId,
        lines: [
          { lotId, binId: null, countedKg: "1", countedBags: null },
          { lotId, binId: null, countedKg: "2", countedBags: null },
        ],
      }),
      "DUPLICATE_LINE",
    );
    const c = await createCount(asDb(db), A.ctx, {
      warehouseId: md.warehouseId,
      lines: [{ lotId, binId: null, countedKg: "9", countedBags: null }],
    });
    expect((await cancelCount(asDb(db), A.ctx, { countId: c.id })).status).toBe("cancelled");
    await expectCode(postCount(asDb(db), A.ctx, { countId: c.id }), "INVALID_STATE");
    const none = await db.select().from(adjustments).where(eq(adjustments.sourceCountId, c.id));
    expect(none).toHaveLength(0);
    expect(await onHand(lotId)).toBe(10_000);
  });

  it("a lot with no stock in the counted warehouse snapshots 0 and a found surplus posts", async () => {
    const lotId = await seedLot(A.ctx, "10", md.warehouseId);
    // Simulate a separate warehouse in a fresh master-data set.
    const md2 = await createMasterData(db, A.ctx);
    const c = await createCount(asDb(db), A.ctx, {
      warehouseId: md2.warehouseId,
      lines: [{ lotId, binId: null, countedKg: "4", countedBags: null }],
    });
    expect(c.lines[0]).toMatchObject({ systemKg: "0.000", diffKg: "4.000" });
    await postCount(asDb(db), A.ctx, { countId: c.id });
    expect((await onHandAt(asDb(db), A.ctx, lotId, md2.warehouseId)).grams).toBe(4_000);
  });

  it("tenancy", async () => {
    const lotId = await seedLot(A.ctx, "10", md.warehouseId);
    const c = await createCount(asDb(db), A.ctx, {
      warehouseId: md.warehouseId,
      lines: [{ lotId, binId: null, countedKg: "10", countedBags: null }],
    });
    await expectCode(getCount(asDb(db), B.ctx, c.id), "NOT_FOUND");
    await expectCode(postCount(asDb(db), B.ctx, { countId: c.id }), "NOT_FOUND");
    await expectCode(
      createCount(asDb(db), B.ctx, {
        warehouseId: md.warehouseId,
        lines: [{ lotId, binId: null, countedKg: "1", countedBags: null }],
      }),
      "NOT_FOUND",
    );
    expect((await listCounts(asDb(db), B.ctx)).total).toBe(0);
  });
});
