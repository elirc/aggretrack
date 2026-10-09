import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "@/db/client";
import { auditLog, lots, purchaseLines, purchases, transferLines, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { postMovements } from "@/lib/services/stockCore";
import {
  getInTransit,
  getLotDetail,
  getMovementHistory,
  getStockAgeing,
  getStockPosition,
  onHandAt,
} from "@/lib/services/stockQueries";
import { lowStock, nearCapacity, oldStock } from "@/lib/services/alertRules";
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
} from "@/lib/services/transfers";
import {
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { createTransferInput } from "@/lib/validation/warehouse";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let whB: string;
let supplierId: string;
let lotSeq = 0;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

/** Seed a received lot: purchase + line + lot + receive movement via stockCore. */
async function seedLot(
  ctx: OrgContext,
  opts: { kg: string; warehouseId: string; bags?: number; priceKobo?: number; receivedAt?: Date },
): Promise<string> {
  const n = ++lotSeq;
  const price = opts.priceKobo ?? 30_000;
  const receivedAt = opts.receivedAt ?? new Date();
  const [p] = await db
    .insert(purchases)
    .values({
      organisationId: ctx.orgId,
      supplierId,
      officerId: ctx.userId,
      purchaseDate: receivedAt.toISOString().slice(0, 10),
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
      bags: opts.bags ?? 0,
      grossKg: opts.kg,
      netKg: opts.kg,
      pricePerKgKobo: price,
      amountKobo: Math.round((kgToGrams(opts.kg) * price) / 1000),
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: ctx.orgId,
      lotNumber: `LOT-T-${n}-${ctx.orgId.slice(0, 6)}`,
      commodityId: md.commodityId,
      gradeId: md.gradeId,
      supplierId,
      purchaseLineId: line.id,
      receivedAt,
      originalKg: opts.kg,
      originalBags: opts.bags ?? 0,
      purchasePricePerKgKobo: price,
      landedCostPerKgKobo: `${price}.0000`,
    })
    .returning({ id: lots.id });
  await (db as unknown as Db).transaction((tx) =>
    postMovements(tx, ctx, [
      {
        lotId: lot.id,
        warehouseId: opts.warehouseId,
        type: "receive",
        grams: kgToGrams(opts.kg),
        bags: opts.bags ?? 0,
        refType: "grn",
        refId: p.id,
        occurredAt: receivedAt,
      },
    ]),
  );
  return lot.id;
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Org A" });
  B = await createTestOrg(db, { name: "Org B" });
  md = await createMasterData(db, A.ctx);
  const [w] = await db
    .insert(warehouses)
    .values({ organisationId: A.orgId, name: "Second Warehouse", capacityKg: "100000.000" })
    .returning({ id: warehouses.id });
  whB = w.id;
  supplierId = await createSupplier(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("transfers", () => {
  it("rejects from === to (zod and service)", async () => {
    const lotId = await seedLot(A.ctx, { kg: "10", warehouseId: md.warehouseId });
    const bad = { fromWarehouseId: md.warehouseId, toWarehouseId: md.warehouseId, lines: [{ lotId, kg: "1" }] };
    expect(createTransferInput.safeParse(bad).success).toBe(false);
    await expectCode(
      createTransfer(asDb(db), A.ctx, { ...bad, lines: [{ lotId, kg: "1", bags: 0 }] }),
      "SAME_WAREHOUSE",
    );
  });

  it("dispatch moves stock out; in transit is not at destination; receive adds received kg; loss math", async () => {
    const lotId = await seedLot(A.ctx, { kg: "100", bags: 10, warehouseId: md.warehouseId });
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "60", bags: 6 }],
    });
    expect(tr.status).toBe("draft");
    expect(tr.transferNumber).toMatch(/^TRF-\d{4}-\d{5}$/);
    // Draft moves nothing.
    expect((await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams).toBe(100_000);

    const sent = await dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id });
    expect(sent.status).toBe("in_transit");
    expect(sent.dispatchedAt).toBeInstanceOf(Date);
    expect(await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).toEqual({ grams: 40_000, bags: 4 });
    expect((await onHandAt(asDb(db), A.ctx, lotId, whB)).grams).toBe(0);

    const transit = await getInTransit(asDb(db), A.ctx);
    const mine = transit.filter((r) => r.transferId === tr.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kg: "60.000", grams: 60_000, bags: 6, valueKobo: 1_800_000 });

    // Dispatching twice is refused.
    await expectCode(dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id }), "INVALID_STATE");
    // Over-receipt is refused.
    await expectCode(
      receiveTransfer(asDb(db), A.ctx, {
        transferId: tr.id,
        lines: [{ lineId: sent.lines[0].id, receivedKg: "60.001", binId: null }],
      }),
      "RECEIVED_EXCEEDS_SENT",
    );

    const got = await receiveTransfer(asDb(db), A.ctx, {
      transferId: tr.id,
      lines: [{ lineId: sent.lines[0].id, receivedKg: "58.250", receivedBags: 6, binId: null }],
    });
    expect(got.status).toBe("received");
    expect(got.lines[0]).toMatchObject({ receivedKg: "58.250", lossKg: "1.750", receivedBags: 6 });
    expect(await onHandAt(asDb(db), A.ctx, lotId, whB)).toEqual({ grams: 58_250, bags: 6 });
    expect((await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams).toBe(40_000);
    expect((await getInTransit(asDb(db), A.ctx)).some((r) => r.transferId === tr.id)).toBe(false);

    // Loss nets out of global stock: 100 − 60 + 58.25.
    const pos = await getStockPosition(asDb(db), A.ctx);
    const lotRows = pos.commodities.flatMap((c) =>
      c.grades.flatMap((g) => g.warehouses.flatMap((w) => w.lots.filter((l) => l.lotId === lotId))),
    );
    expect(lotRows.reduce((s, l) => s + l.grams, 0)).toBe(98_250);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organisationId, A.orgId), eq(auditLog.recordId, tr.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["create", "update", "update"]);
  });

  it("oversend is rejected with INSUFFICIENT_STOCK and leaves the transfer draft", async () => {
    const lotId = await seedLot(A.ctx, { kg: "40", warehouseId: md.warehouseId });
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "40.001", bags: 0 }],
    });
    await expectCode(dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id }), "INSUFFICIENT_STOCK");
    expect((await getTransfer(asDb(db), A.ctx, tr.id)).status).toBe("draft");
    expect((await onHandAt(asDb(db), A.ctx, lotId, md.warehouseId)).grams).toBe(40_000);
  });

  it("zero receipt records total loss with no transfer_in movement", async () => {
    const lotId = await seedLot(A.ctx, { kg: "5", warehouseId: md.warehouseId });
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "5", bags: 0 }],
    });
    const sent = await dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id });
    const got = await receiveTransfer(asDb(db), A.ctx, {
      transferId: tr.id,
      lines: [{ lineId: sent.lines[0].id, receivedKg: "0", binId: null }],
    });
    expect(got.lines[0].lossKg).toBe("5.000");
    expect((await onHandAt(asDb(db), A.ctx, lotId, whB)).grams).toBe(0);
  });

  it("cancel only from draft", async () => {
    const lotId = await seedLot(A.ctx, { kg: "10", warehouseId: md.warehouseId });
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "1", bags: 0 }],
    });
    expect((await cancelTransfer(asDb(db), A.ctx, { transferId: tr.id })).status).toBe("cancelled");
    await expectCode(dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id }), "INVALID_STATE");
    const tr2 = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "1", bags: 0 }],
    });
    await dispatchTransfer(asDb(db), A.ctx, { transferId: tr2.id });
    await expectCode(cancelTransfer(asDb(db), A.ctx, { transferId: tr2.id }), "INVALID_STATE");
    const lines = await db.select().from(transferLines).where(eq(transferLines.transferId, tr2.id));
    expect(lines[0].lossKg).toBeNull();
  });

  it("tenancy + warehouse restriction + hidden prices", async () => {
    const lotId = await seedLot(A.ctx, { kg: "10", warehouseId: md.warehouseId });
    const tr = await createTransfer(asDb(db), A.ctx, {
      fromWarehouseId: md.warehouseId,
      toWarehouseId: whB,
      lines: [{ lotId, kg: "2", bags: 0 }],
    });
    await expectCode(getTransfer(asDb(db), B.ctx, tr.id), "NOT_FOUND");
    await expectCode(dispatchTransfer(asDb(db), B.ctx, { transferId: tr.id }), "NOT_FOUND");
    expect((await listTransfers(asDb(db), B.ctx)).total).toBe(0);

    const keeperB: OrgContext = {
      ...A.ctx,
      role: "warehouse",
      restrictions: { warehouseIds: [whB], buyingPointIds: null, hidePrices: true },
    };
    // Restricted to destination: can't dispatch from source.
    await expectCode(dispatchTransfer(asDb(db), keeperB, { transferId: tr.id }), "FORBIDDEN");
    await dispatchTransfer(asDb(db), A.ctx, { transferId: tr.id });
    const transit = await getInTransit(asDb(db), keeperB);
    const row = transit.find((r) => r.transferId === tr.id)!;
    expect(row).toBeDefined();
    expect("valueKobo" in row).toBe(false);

    const pos = await getStockPosition(asDb(db), keeperB);
    expect("valueKobo" in pos.totals).toBe(false);
    for (const c of pos.commodities)
      for (const g of c.grades)
        for (const w of g.warehouses) {
          expect(w.warehouseId).toBe(whB);
          for (const l of w.lots) {
            expect("valueKobo" in l).toBe(false);
            expect("landedCostPerKgKobo" in l).toBe(false);
          }
        }
  });

  it("ageing bands, movement history, lot detail and alert rules", async () => {
    // Fresh org so totals are exact; seedLot reads the module-level md/supplierId.
    const C = await createTestOrg(db, { name: "Org C" });
    const saved = { md, supplierId };
    md = await createMasterData(db, C.ctx);
    supplierId = await createSupplier(db, C.ctx);
    try {
      const asOf = new Date("2026-10-08T12:00:00Z");
      const oldLot = await seedLot(C.ctx, {
        kg: "10",
        warehouseId: md.warehouseId,
        receivedAt: new Date("2026-06-01T09:00:00Z"),
      });
      await seedLot(C.ctx, { kg: "20", warehouseId: md.warehouseId, receivedAt: new Date("2026-08-20T09:00:00Z") });
      await seedLot(C.ctx, { kg: "30", warehouseId: md.warehouseId, receivedAt: new Date("2026-10-01T09:00:00Z") });

      const ageing = await getStockAgeing(asDb(db), C.ctx, { asOf });
      expect(ageing.bands.d0_30).toEqual({ kg: "30.000", grams: 30_000, valueKobo: 900_000 });
      expect(ageing.bands.d31_60).toEqual({ kg: "20.000", grams: 20_000, valueKobo: 600_000 });
      expect(ageing.bands.d61_90).toEqual({ kg: "0.000", grams: 0, valueKobo: 0 });
      expect(ageing.bands.d90_plus).toEqual({ kg: "10.000", grams: 10_000, valueKobo: 300_000 });
      expect(ageing.rows.map((r) => r.band)).toEqual(["d90_plus", "d31_60", "d0_30"]);
      const hidden = await getStockAgeing(asDb(db), { ...C.ctx, restrictions: { ...C.ctx.restrictions, hidePrices: true } }, { asOf });
      expect("valueKobo" in hidden.bands.d0_30).toBe(false);
      expect("valueKobo" in hidden.rows[0]).toBe(false);

      const page1 = await getMovementHistory(asDb(db), C.ctx, { page: 1, pageSize: 2 });
      expect(page1.total).toBe(3);
      expect(page1.rows).toHaveLength(2);
      const day = await getMovementHistory(asDb(db), C.ctx, { fromDate: "2026-06-01", toDate: "2026-06-01" });
      expect(day.rows.map((r) => r.lotId)).toEqual([oldLot]);
      const byType = await getMovementHistory(asDb(db), C.ctx, { type: "transfer_out" });
      expect(byType.total).toBe(0);
      expect((await getMovementHistory(asDb(db), A.ctx, { lotId: oldLot })).total).toBe(0);

      const detail = await getLotDetail(asDb(db), C.ctx, { lotId: oldLot });
      expect(detail).toMatchObject({
        purchasePricePerKgKobo: 30_000,
        landedCostPerKgKobo: 30_000,
        onHand: { kg: "10.000", grams: 10_000, valueKobo: 300_000 },
      });
      expect(detail.movements).toHaveLength(1);
      await expectCode(getLotDetail(asDb(db), A.ctx, { lotId: oldLot }), "NOT_FOUND");

      await db.update(warehouses).set({ capacityKg: "65" }).where(eq(warehouses.id, md.warehouseId));
      const settings = { lowStockThresholdKg: "1000", oldStockDays: 90, capacityAlertPercent: 90 };
      const low = await lowStock(asDb(db), C.orgId, settings);
      expect(low).toEqual([
        expect.objectContaining({ commodityId: md.commodityId, onHandKg: "60.000", thresholdKg: "1000.000" }),
      ]);
      const olds = await oldStock(asDb(db), C.orgId, settings, asOf);
      expect(olds.map((r) => r.lotId)).toEqual([oldLot]);
      expect(olds[0].ageDays).toBe(129);
      const cap = await nearCapacity(asDb(db), C.orgId, settings);
      expect(cap).toEqual([expect.objectContaining({ warehouseId: md.warehouseId, usedPercent: 92.31 })]);
      expect(await nearCapacity(asDb(db), C.orgId, { ...settings, capacityAlertPercent: 93 })).toEqual([]);
    } finally {
      md = saved.md;
      supplierId = saved.supplierId;
    }
  });
});
