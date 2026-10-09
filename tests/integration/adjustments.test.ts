import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "@/db/client";
import {
  adjustments,
  auditLog,
  lots,
  notifications,
  organisationSettings,
  purchaseLines,
  purchases,
  stockMovements,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import {
  approvalQueue,
  approveAdjustment,
  createAdjustment,
  listAdjustments,
  rejectAdjustment,
} from "@/lib/services/adjustments";
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
import { createAdjustmentInput } from "@/lib/validation/warehouse";

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
      pricePerKgKobo: 25_000,
      amountKobo: (kgToGrams(kg) * 25_000) / 1000,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: ctx.orgId,
      lotNumber: `LOT-A-${n}`,
      commodityId: md.commodityId,
      gradeId: md.gradeId,
      supplierId,
      purchaseLineId: line.id,
      receivedAt: new Date(),
      originalKg: kg,
      purchasePricePerKgKobo: 25_000,
      landedCostPerKgKobo: "25000.0000",
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

async function movementCount(adjustmentId: string) {
  const rows = await db.select().from(stockMovements).where(eq(stockMovements.refId, adjustmentId));
  return rows.length;
}

async function auditActions(recordId: string) {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.organisationId, A.orgId), eq(auditLog.recordId, recordId)));
  return rows.map((r) => r.action).sort();
}

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

describe("adjustments", () => {
  it("validation: manual reasons only, non-zero signed kg", () => {
    const base = { lotId: md.commodityId, warehouseId: md.warehouseId, kg: "-5" };
    expect(createAdjustmentInput.safeParse({ ...base, reason: "shrinkage" }).success).toBe(true);
    expect(createAdjustmentInput.safeParse({ ...base, reason: "count_difference" }).success).toBe(false);
    expect(createAdjustmentInput.safeParse({ ...base, reason: "theft", kg: "0" }).success).toBe(false);
  });

  it("at/below threshold auto-posts in the same tx with an ADJ number", async () => {
    const lotId = await seedLot(A.ctx, "100", md.warehouseId);
    const adj = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "shrinkage",
      kg: "-50",
      bags: 0,
      note: null,
    });
    expect(adj.status).toBe("posted");
    expect(adj.approvedBy).toBeNull();
    expect(adj.adjustmentNumber).toMatch(/^ADJ-\d{4}-\d{5}$/);
    expect(await onHand(lotId)).toBe(50_000);
    expect(await movementCount(adj.id)).toBe(1);
    expect(await auditActions(adj.id)).toEqual(["create", "post"]);
  });

  it("above threshold → pending (no movement, notification) → approve posts", async () => {
    const lotId = await seedLot(A.ctx, "100", md.warehouseId);
    const adj = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "spoilage",
      kg: "-50.001",
      bags: 0,
      note: "wet bags",
    });
    expect(adj.status).toBe("pending_approval");
    expect(await movementCount(adj.id)).toBe(0);
    expect(await onHand(lotId)).toBe(100_000);
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.organisationId, A.orgId), eq(notifications.type, "approval_request")));
    expect(notes.some((n) => n.title.includes(adj.adjustmentNumber))).toBe(true);
    expect((await approvalQueue(asDb(db), A.ctx)).map((a) => a.id)).toContain(adj.id);

    // A warehouse keeper cannot approve.
    const keeper: OrgContext = { ...A.ctx, role: "warehouse" };
    await expectCode(approveAdjustment(asDb(db), keeper, { adjustmentId: adj.id }), "FORBIDDEN");

    const posted = await approveAdjustment(asDb(db), A.ctx, { adjustmentId: adj.id });
    expect(posted.status).toBe("posted");
    expect(posted.approvedBy).toBe(A.userId);
    expect(await onHand(lotId)).toBe(49_999);
    expect(await movementCount(adj.id)).toBe(1);
    await expectCode(approveAdjustment(asDb(db), A.ctx, { adjustmentId: adj.id }), "INVALID_STATE");
    expect(await auditActions(adj.id)).toEqual(["approve", "create"]);
    expect((await approvalQueue(asDb(db), A.ctx)).map((a) => a.id)).not.toContain(adj.id);
  });

  it("reject leaves stock unchanged", async () => {
    const lotId = await seedLot(A.ctx, "100", md.warehouseId);
    const adj = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "theft",
      kg: "-70",
      bags: 0,
      note: null,
    });
    const rejected = await rejectAdjustment(asDb(db), A.ctx, { adjustmentId: adj.id, reason: "Recounted, fine" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedReason).toBe("Recounted, fine");
    expect(await onHand(lotId)).toBe(100_000);
    expect(await movementCount(adj.id)).toBe(0);
    await expectCode(approveAdjustment(asDb(db), A.ctx, { adjustmentId: adj.id }), "INVALID_STATE");
    expect(await auditActions(adj.id)).toEqual(["create", "reject"]);
  });

  it("negative adjustment that would break the floor is rejected (auto and on approval)", async () => {
    const lotId = await seedLot(A.ctx, "30", md.warehouseId);
    const before = (await listAdjustments(asDb(db), A.ctx, { lotId })).total;
    await expectCode(
      createAdjustment(asDb(db), A.ctx, {
        lotId,
        warehouseId: md.warehouseId,
        binId: null,
        reason: "shrinkage",
        kg: "-30.001",
        bags: 0,
        note: null,
      }),
      "INSUFFICIENT_STOCK",
    );
    // Whole tx rolled back — no adjustment row survives.
    expect((await listAdjustments(asDb(db), A.ctx, { lotId })).total).toBe(before);
    expect(await onHand(lotId)).toBe(30_000);

    // Pending −80 on a 30 kg lot: approval fails, stays pending, stock unchanged.
    const big = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "spoilage",
      kg: "-80",
      bags: 0,
      note: null,
    });
    await expectCode(approveAdjustment(asDb(db), A.ctx, { adjustmentId: big.id }), "INSUFFICIENT_STOCK");
    const [row] = await db.select().from(adjustments).where(eq(adjustments.id, big.id));
    expect(row.status).toBe("pending_approval");
    expect(await onHand(lotId)).toBe(30_000);

    // Exactly to zero is legal.
    const zero = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "shrinkage",
      kg: "-30",
      bags: 0,
      note: null,
    });
    expect(zero.status).toBe("posted");
    expect(await onHand(lotId)).toBe(0);
  });

  it("threshold follows the org setting; positive adjustments post", async () => {
    await db
      .update(organisationSettings)
      .set({ adjustmentApprovalThresholdKg: "5" })
      .where(eq(organisationSettings.organisationId, A.orgId));
    const lotId = await seedLot(A.ctx, "10", md.warehouseId);
    const a = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: null,
      reason: "re_bagging",
      kg: "6",
      bags: 0,
      note: null,
    });
    expect(a.status).toBe("pending_approval");
    const b = await createAdjustment(asDb(db), A.ctx, {
      lotId,
      warehouseId: md.warehouseId,
      binId: md.binId,
      reason: "re_bagging",
      kg: "5",
      bags: 0,
      note: null,
    });
    expect(b.status).toBe("posted");
    expect(await onHand(lotId)).toBe(15_000);
    await db
      .update(organisationSettings)
      .set({ adjustmentApprovalThresholdKg: "50" })
      .where(eq(organisationSettings.organisationId, A.orgId));
  });

  it("tenancy and warehouse restriction", async () => {
    const lotId = await seedLot(A.ctx, "10", md.warehouseId);
    await expectCode(
      createAdjustment(asDb(db), B.ctx, {
        lotId,
        warehouseId: md.warehouseId,
        binId: null,
        reason: "theft",
        kg: "-1",
        bags: 0,
        note: null,
      }),
      "NOT_FOUND",
    );
    const restricted: OrgContext = {
      ...A.ctx,
      restrictions: {
        warehouseIds: ["00000000-0000-4000-8000-000000000000"],
        buyingPointIds: null,
        hidePrices: false,
      },
    };
    await expectCode(
      createAdjustment(asDb(db), restricted, {
        lotId,
        warehouseId: md.warehouseId,
        binId: null,
        reason: "theft",
        kg: "-1",
        bags: 0,
        note: null,
      }),
      "FORBIDDEN",
    );
    expect((await listAdjustments(asDb(db), B.ctx)).total).toBe(0);
    expect((await listAdjustments(asDb(db), restricted)).total).toBe(0);
  });
});
