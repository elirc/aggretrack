import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import {
  dispatches,
  dispatchLines,
  grades,
  lotAllocations,
  lots,
  purchaseLines,
  purchases,
  salesOrders,
  stockMovements,
} from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { releaseAllocation, reserveForSalesLine } from "@/lib/services/allocation";
import { createDispatch, getDispatch, listDispatches, recordDelivery } from "@/lib/services/dispatches";
import { confirmSalesOrder, createSalesOrder } from "@/lib/services/salesOrders";
import { availableGrams, lotOnHand, postMovements } from "@/lib/services/stockCore";
import {
  createCustomer,
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
let customerId: string;

const jobs: { queue: string; data: object }[] = [];
const deps = {
  enqueue: async (queue: string, data: object) => {
    jobs.push({ queue, data });
    return "job-id";
  },
};

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

let seq = 0;
async function seedLot(opts: { kg: string; receivedAt: Date; gradeId: string }) {
  const n = ++seq;
  const [p] = await db
    .insert(purchases)
    .values({ organisationId: A.orgId, supplierId, officerId: A.userId, purchaseDate: "2026-01-01", status: "received" })
    .returning({ id: purchases.id });
  const [pl] = await db
    .insert(purchaseLines)
    .values({
      purchaseId: p.id,
      organisationId: A.orgId,
      commodityId: md.commodityId,
      gradeId: opts.gradeId,
      grossKg: opts.kg,
      netKg: opts.kg,
      pricePerKgKobo: 20_000,
      amountKobo: 0,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: A.orgId,
      lotNumber: `LOT-DS-${n}-${randomUUID().slice(0, 6)}`,
      commodityId: md.commodityId,
      gradeId: opts.gradeId,
      supplierId,
      purchaseLineId: pl.id,
      receivedAt: opts.receivedAt,
      originalKg: opts.kg,
      purchasePricePerKgKobo: 20_000,
      landedCostPerKgKobo: "20000",
    })
    .returning({ id: lots.id });
  await asDb(db).transaction((tx) =>
    postMovements(tx, A.ctx, [
      {
        lotId: lot.id,
        warehouseId: md.warehouseId,
        type: "receive",
        grams: kgToGrams(opts.kg),
        bags: 0,
        refType: "grn",
        refId: p.id,
      },
    ]),
  );
  return lot.id;
}

async function newGrade(): Promise<string> {
  const n = ++seq;
  const [g] = await db
    .insert(grades)
    .values({ organisationId: A.orgId, commodityId: md.commodityId, name: `DG-${n}`, code: `DG${n}` })
    .returning({ id: grades.id });
  return g.id;
}

/** Fresh grade + lots + confirmed order, FIFO-reserved. */
async function allocatedOrder(lotKgs: string[], lineKg: string) {
  const gradeId = await newGrade();
  const lotIds: string[] = [];
  for (let i = 0; i < lotKgs.length; i++) {
    lotIds.push(await seedLot({ kg: lotKgs[i], receivedAt: new Date(Date.UTC(2026, 0, 1 + i)), gradeId }));
  }
  const order = await createSalesOrder(asDb(db), A.ctx, {
    customerId,
    orderDate: "2026-02-01",
    lines: [{ commodityId: md.commodityId, gradeId, kg: lineKg, pricePerKgKobo: 35_000 }],
  });
  await confirmSalesOrder(asDb(db), A.ctx, { id: order.id });
  const allocations = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" });
  return { order, allocations, lotIds };
}

async function orderStatus(id: string) {
  const [o] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, id));
  return o.status;
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Dispatch A" });
  B = await createTestOrg(db, { name: "Dispatch B" });
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
  customerId = await createCustomer(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("createDispatch", () => {
  it("writes −kg dispatch movements, flips allocations, numbers the waybill, enqueues the PDF", async () => {
    jobs.length = 0;
    const { order, allocations, lotIds } = await allocatedOrder(["40", "60"], "70");
    expect(allocations.map((a) => a.kg)).toEqual(["40.000", "30.000"]);

    const res = await createDispatch(
      asDb(db),
      A.ctx,
      {
        salesOrderId: order.id,
        allocationIds: allocations.map((a) => a.id),
        vehicleId: md.vehicleId,
        driverId: md.driverId,
      },
      deps,
    );
    expect(res.duplicate).toBe(false);
    expect(res.dispatch.waybillNumber).toMatch(/^WB-\d{4}-00001$/);
    expect(res.dispatch.dispatchedKg).toBe("70.000");
    expect(res.dispatch.status).toBe("in_transit");
    expect(res.lines.map((l) => l.kg).sort()).toEqual(["30.000", "40.000"]);

    const moves = await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.refId, res.dispatch.id), eq(stockMovements.type, "dispatch")));
    expect(moves.map((m) => [m.lotId, m.kg, m.refType]).sort()).toEqual(
      [
        [lotIds[0], "-40.000", "wb"],
        [lotIds[1], "-30.000", "wb"],
      ].sort(),
    );

    const flipped = await db.select().from(lotAllocations).where(eq(lotAllocations.salesLineId, order.lines[0].id));
    expect(flipped.map((a) => a.status)).toEqual(["dispatched", "dispatched"]);

    expect((await lotOnHand(asDb(db), A.ctx, lotIds[0])).grams).toBe(0);
    expect((await lotOnHand(asDb(db), A.ctx, lotIds[1])).grams).toBe(30_000);
    // Reservation is gone (flipped) and stock left: available == on-hand.
    expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lotIds[1], md.warehouseId))).toBe(30_000);

    expect(await orderStatus(order.id)).toBe("dispatched");
    expect(jobs).toEqual([
      { queue: QUEUES.DOCUMENT_GENERATE, data: { kind: "waybill", refId: res.dispatch.id, orgId: A.orgId } },
    ]);

    const detail = await getDispatch(asDb(db), A.ctx, { id: res.dispatch.id });
    expect(detail.vehiclePlate).toBeTruthy();
    expect(detail.lines).toHaveLength(2);
    const list = await listDispatches(asDb(db), A.ctx, { salesOrderId: order.id });
    expect(list.total).toBe(1);
    await expectCode(getDispatch(asDb(db), B.ctx, { id: res.dispatch.id }), "NOT_FOUND");
  });

  it("rejects non-reserved allocations and allocations from another order", async () => {
    const first = await allocatedOrder(["50"], "20");
    const second = await allocatedOrder(["50"], "20");

    await expectCode(
      createDispatch(asDb(db), A.ctx, { salesOrderId: first.order.id, allocationIds: [second.allocations[0].id] }, deps),
      "ALLOCATION_NOT_IN_ORDER",
    );

    await releaseAllocation(asDb(db), A.ctx, { allocationId: first.allocations[0].id });
    await expectCode(
      createDispatch(asDb(db), A.ctx, { salesOrderId: first.order.id, allocationIds: [first.allocations[0].id] }, deps),
      "ALLOCATION_NOT_RESERVED",
    );
    await expectCode(
      createDispatch(asDb(db), B.ctx, { salesOrderId: second.order.id, allocationIds: [second.allocations[0].id] }, deps),
      "NOT_FOUND",
    );
    // nothing was written
    const rows = await db.select().from(dispatches).where(eq(dispatches.salesOrderId, first.order.id));
    expect(rows).toHaveLength(0);
  });

  it("partial dispatch keeps the order allocated", async () => {
    const { order, allocations } = await allocatedOrder(["10", "10"], "20");
    expect(allocations).toHaveLength(2);
    await createDispatch(asDb(db), A.ctx, { salesOrderId: order.id, allocationIds: [allocations[0].id] }, deps);
    expect(await orderStatus(order.id)).toBe("allocated");
    await createDispatch(asDb(db), A.ctx, { salesOrderId: order.id, allocationIds: [allocations[1].id] }, deps);
    expect(await orderStatus(order.id)).toBe("dispatched");
  });
});

describe("clientId idempotency", () => {
  it("the same offline dispatch submitted twice creates one dispatch", async () => {
    jobs.length = 0;
    const { order, allocations, lotIds } = await allocatedOrder(["30"], "25");
    const clientId = randomUUID();
    const input = { clientId, salesOrderId: order.id, allocationIds: allocations.map((a) => a.id) };

    const first = await createDispatch(asDb(db), A.ctx, input, deps);
    const second = await createDispatch(asDb(db), A.ctx, input, deps);
    expect(first.duplicate).toBe(false);
    expect(first.dispatch.id).toBe(clientId);
    expect(second.duplicate).toBe(true);
    expect(second.dispatch.id).toBe(clientId);
    expect(second.dispatch.waybillNumber).toBe(first.dispatch.waybillNumber);

    expect(await db.select().from(dispatches).where(eq(dispatches.id, clientId))).toHaveLength(1);
    expect(await db.select().from(dispatchLines).where(eq(dispatchLines.dispatchId, clientId))).toHaveLength(1);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.refId, clientId))).toHaveLength(1);
    expect((await lotOnHand(asDb(db), A.ctx, lotIds[0])).grams).toBe(5_000);
    expect(jobs).toHaveLength(1);
  });

  it("two concurrent replays of the same clientId still create one dispatch", async () => {
    const { order, allocations, lotIds } = await allocatedOrder(["30"], "30");
    const clientId = randomUUID();
    const input = { clientId, salesOrderId: order.id, allocationIds: allocations.map((a) => a.id) };
    const results = await Promise.all([
      createDispatch(asDb(db), A.ctx, input, deps),
      createDispatch(asDb(db), A.ctx, input, deps),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await db.select().from(dispatches).where(eq(dispatches.id, clientId))).toHaveLength(1);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.refId, clientId))).toHaveLength(1);
    expect((await lotOnHand(asDb(db), A.ctx, lotIds[0])).grams).toBe(0);
  });
});

describe("recordDelivery", () => {
  it("records delivered weight and transit loss, completes the order", async () => {
    const { order, allocations } = await allocatedOrder(["100"], "60");
    const { dispatch } = await createDispatch(
      asDb(db),
      A.ctx,
      { salesOrderId: order.id, allocationIds: allocations.map((a) => a.id) },
      deps,
    );

    await expectCode(
      recordDelivery(asDb(db), A.ctx, { dispatchId: dispatch.id, deliveredKg: "60.001" }),
      "DELIVERED_EXCEEDS_DISPATCHED",
    );
    const delivered = await recordDelivery(asDb(db), A.ctx, { dispatchId: dispatch.id, deliveredKg: "58.5" });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredKg).toBe("58.500");
    expect(delivered.transitLossKg).toBe("1.500");
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    expect(await orderStatus(order.id)).toBe("completed");

    await expectCode(
      recordDelivery(asDb(db), A.ctx, { dispatchId: dispatch.id, deliveredKg: "58.5" }),
      "DISPATCH_ALREADY_DELIVERED",
    );
    // Loss is reporting-only: no extra stock movement.
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.refId, dispatch.id));
    expect(moves.map((m) => m.kg)).toEqual(["-60.000"]);
  });

  it("zero loss when everything arrives", async () => {
    const { order, allocations } = await allocatedOrder(["10"], "10");
    const { dispatch } = await createDispatch(
      asDb(db),
      A.ctx,
      { salesOrderId: order.id, allocationIds: allocations.map((a) => a.id) },
      deps,
    );
    const delivered = await recordDelivery(asDb(db), A.ctx, { dispatchId: dispatch.id, deliveredKg: "10" });
    expect(delivered.transitLossKg).toBe("0.000");
  });
});
