import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { lots, purchases, stockMovements, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { lagosYear } from "@/lib/services/numbering";
import * as purchasesSvc from "@/lib/services/purchases";
import { receivePurchase } from "@/lib/services/receiving";
import { lotOnHand } from "@/lib/services/stockCore";
import { createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { purchaseCreateInput, receivePurchaseInput } from "@/lib/validation/buying";

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

async function approvedPurchase(lines: Array<Record<string, unknown>>) {
  const { purchase } = await purchasesSvc.createPurchase(
    asDb(db),
    A.ctx,
    purchaseCreateInput.parse({
      supplierId,
      buyingPointId: md.buyingPointId,
      purchaseDate: "2026-10-05",
      lines: lines.map((l) => ({ commodityId: md.commodityId, gradeId: md.gradeId, deductions: [], ...l })),
    }),
  );
  expect(purchase.status).toBe("approved");
  return purchase;
}

const receive = (ctx: OrgContext, purchaseId: string, extra: Record<string, unknown> = {}, d: DbOrTx = asDb(db)) =>
  receivePurchase(d, ctx, receivePurchaseInput.parse({ purchaseId, warehouseId: md.warehouseId, ...extra }));

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

describe("receivePurchase", () => {
  it("creates one lot per line with the line's cost and movements summing to net kg", async () => {
    const p = await approvedPurchase([
      { bagTypeId: md.bagTypeId, bags: 10, grossKg: "1012", pricePerKgKobo: 30_555 }, // net 1000 (10 × 1.2 sack)
      { grossKg: "250.75", pricePerKgKobo: 41_000, deductions: [{ reason: "moisture", kg: "0.75" }] }, // net 250
    ]);
    const res = await receive(A.ctx, p.id, { binId: md.binId, sendSms: true });

    expect(res.grnNumber).toBe(`GRN-${YEAR}-00001`);
    expect(res.totalNetKg).toBe("1250.000");
    expect(res.lots.map((l) => l.lotNumber)).toEqual([`LOT-${YEAR}-00001`, `LOT-${YEAR}-00002`]);

    const [l1, l2] = res.lots;
    expect(l1.purchaseLineId).toBe(p.lines[0].id);
    expect(l1.originalKg).toBe("1000.000");
    expect(l1.originalBags).toBe(10);
    expect(l1.purchasePricePerKgKobo).toBe(30_555);
    expect(Number(l1.landedCostPerKgKobo)).toBe(30_555); // landed = price until trips attach
    expect(l1.supplierId).toBe(supplierId);
    expect(l1.commodityId).toBe(md.commodityId);
    expect(l2.originalKg).toBe("250.000");
    expect(l2.purchasePricePerKgKobo).toBe(41_000);
    expect(Number(l2.landedCostPerKgKobo)).toBe(41_000);

    // stock on hand (Σ movements) per lot == lot net weight
    const oh1 = await lotOnHand(asDb(db), A.ctx, l1.id);
    const oh2 = await lotOnHand(asDb(db), A.ctx, l2.id);
    expect(oh1).toEqual({ grams: 1_000_000, bags: 10 });
    expect(oh2).toEqual({ grams: 250_000, bags: 0 });
    expect(oh1.grams + oh2.grams).toBe(kgToGrams(p.netKg));

    const moves = await db.select().from(stockMovements).where(eq(stockMovements.organisationId, A.orgId));
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect(m.type).toBe("receive");
      expect(m.refType).toBe("grn");
      expect(m.refId).toBe(p.id);
      expect(m.warehouseId).toBe(md.warehouseId);
      expect(m.binId).toBe(md.binId);
      expect(m.createdBy).toBe(A.userId);
    }

    const [after] = await db.select().from(purchases).where(eq(purchases.id, p.id));
    expect(after.status).toBe("received");
    expect(after.grnNumber).toBe(res.grnNumber);
    expect(after.receivedWarehouseId).toBe(md.warehouseId);
    expect(after.receivedAt).toBeInstanceOf(Date);

    // jobs returned for enqueue-after-commit
    expect(res.jobs[0]).toEqual({ name: QUEUES.DOCUMENT_GENERATE, data: { kind: "grn", refId: p.id, orgId: A.orgId } });
    const sms = res.jobs.find((j) => j.name === QUEUES.SMS_SEND);
    expect(sms).toBeDefined();
    if (sms?.name === QUEUES.SMS_SEND) {
      expect(sms.data.to).toMatch(/^23481\d{8}$/);
      expect(sms.data.body).toContain("1250.000 kg");
      expect(sms.data.body).toContain("10 bags");
      expect(sms.data.body).toContain("₦");
      expect(sms.data.body).toContain(res.grnNumber);
    }

    // detail now links the lots
    const detail = await purchasesSvc.getPurchaseDetail(asDb(db), A.ctx, p.id);
    expect(detail.lines.map((l) => l.lot?.lotNumber)).toEqual([l1.lotNumber, l2.lotNumber]);
  });

  it("numbers GRNs gaplessly across receives, including after a rolled-back receive", async () => {
    const p1 = await approvedPurchase([{ grossKg: "100", pricePerKgKobo: 1000 }]);
    const p2 = await approvedPurchase([{ grossKg: "200", pricePerKgKobo: 1000 }]);
    const p3 = await approvedPurchase([{ grossKg: "300", pricePerKgKobo: 1000 }]);

    const r1 = await receive(A.ctx, p1.id);
    expect(r1.grnNumber).toBe(`GRN-${YEAR}-00001`);
    expect(r1.jobs).toHaveLength(1); // no SMS unless asked

    // receive p2 inside an outer tx that then rolls back → its GRN/LOT numbers are released
    await expect(
      db.transaction(async (tx) => {
        const r = await receive(A.ctx, p2.id, {}, tx as unknown as Tx);
        expect(r.grnNumber).toBe(`GRN-${YEAR}-00002`);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.select().from(lots).where(eq(lots.organisationId, A.orgId))).toHaveLength(1);

    const r3 = await receive(A.ctx, p3.id);
    const r2 = await receive(A.ctx, p2.id);
    expect(r3.grnNumber).toBe(`GRN-${YEAR}-00002`);
    expect(r2.grnNumber).toBe(`GRN-${YEAR}-00003`);
    expect(r3.lots[0].lotNumber).toBe(`LOT-${YEAR}-00002`);
    expect(r2.lots[0].lotNumber).toBe(`LOT-${YEAR}-00003`);
  });

  it("rejects double receive, unapproved purchases and leaves stock untouched", async () => {
    const p = await approvedPurchase([{ grossKg: "100", pricePerKgKobo: 1000 }]);
    const r = await receive(A.ctx, p.id);
    await expectCode(receive(A.ctx, p.id), "ALREADY_RECEIVED");
    expect(await lotOnHand(asDb(db), A.ctx, r.lots[0].id)).toEqual({ grams: 100_000, bags: 0 });
    expect(await db.select().from(lots).where(eq(lots.organisationId, A.orgId))).toHaveLength(1);
    await expectCode(purchasesSvc.cancelPurchase(asDb(db), A.ctx, { id: p.id, reason: null }), "CANNOT_CANCEL_RECEIVED");

    const { purchase: draft } = await purchasesSvc.createPurchase(
      asDb(db),
      A.ctx,
      purchaseCreateInput.parse({
        supplierId,
        buyingPointId: md.buyingPointId,
        purchaseDate: "2026-10-05",
        saveAsDraft: true,
        lines: [{ commodityId: md.commodityId, gradeId: md.gradeId, grossKg: "5", pricePerKgKobo: 1 }],
      }),
    );
    await expectCode(receive(A.ctx, draft.id), "NOT_APPROVED");
    const cancelled = await approvedPurchase([{ grossKg: "1", pricePerKgKobo: 1 }]);
    await purchasesSvc.cancelPurchase(asDb(db), A.ctx, { id: cancelled.id, reason: null });
    await expectCode(receive(A.ctx, cancelled.id), "NOT_APPROVED");
  });

  it("enforces warehouse restrictions, bin ownership and org scope", async () => {
    const p = await approvedPurchase([{ grossKg: "100", pricePerKgKobo: 1000 }]);
    const [wh2] = await db
      .insert(warehouses)
      .values({ organisationId: A.orgId, name: "Second Warehouse" })
      .returning({ id: warehouses.id });
    const keeper: OrgContext = {
      ...A.ctx,
      role: "warehouse",
      restrictions: { ...A.ctx.restrictions, warehouseIds: [wh2.id] },
    };
    await expectCode(receive(keeper, p.id), "FORBIDDEN");
    await expectCode(receive(A.ctx, p.id, { warehouseId: wh2.id, binId: md.binId }), "BIN_WAREHOUSE_MISMATCH");

    const B = await createTestOrg(db);
    const mdB = await createMasterData(db, B.ctx);
    await expectCode(receive(B.ctx, p.id, { warehouseId: mdB.warehouseId }), "NOT_FOUND");
    await expectCode(receive(A.ctx, p.id, { warehouseId: mdB.warehouseId }), "NOT_FOUND");

    const ok = await receive(keeper, p.id, { warehouseId: wh2.id });
    expect(ok.warehouseId).toBe(wh2.id);
    const moves = await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.organisationId, A.orgId), eq(stockMovements.warehouseId, wh2.id)));
    expect(moves).toHaveLength(1);
  });
});
