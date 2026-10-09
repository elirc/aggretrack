import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import * as schema from "@/db/schema";
import { grades, lotAllocations, lots, purchaseLines, purchases, salesOrders, warehouses } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import {
  autoAllocateOrder,
  listAvailableLots,
  releaseAllocation,
  reserveForSalesLine,
} from "@/lib/services/allocation";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  getSalesOrder,
  updateSalesOrder,
} from "@/lib/services/salesOrders";
import { availableGrams, postMovements } from "@/lib/services/stockCore";
import {
  createCustomer,
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, testDbUrl, truncateAll, type TestDb } from "@/lib/test/setup";
import { reserveInput } from "@/lib/validation/selling";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let wh2: string;
let supplierId: string;
let customerId: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

let lotSeq = 0;
/** Seed a received lot directly (lots + receive movement through stockCore). */
async function seedLot(opts: { kg: string; receivedAt: Date; gradeId: string; warehouseId?: string; priceKobo?: number }) {
  const n = ++lotSeq;
  const price = opts.priceKobo ?? 25_000;
  const [p] = await db
    .insert(purchases)
    .values({
      organisationId: A.orgId,
      supplierId,
      officerId: A.userId,
      purchaseDate: "2026-01-01",
      status: "received",
    })
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
      pricePerKgKobo: price,
      amountKobo: 0,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: A.orgId,
      lotNumber: `LOT-SA-${n}-${randomUUID().slice(0, 6)}`,
      commodityId: md.commodityId,
      gradeId: opts.gradeId,
      supplierId,
      purchaseLineId: pl.id,
      receivedAt: opts.receivedAt,
      originalKg: opts.kg,
      purchasePricePerKgKobo: price,
      landedCostPerKgKobo: String(price),
    })
    .returning({ id: lots.id });
  await asDb(db).transaction((tx) =>
    postMovements(tx, A.ctx, [
      {
        lotId: lot.id,
        warehouseId: opts.warehouseId ?? md.warehouseId,
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

let gradeSeq = 0;
/** A fresh grade per test keeps candidate lot sets isolated. */
async function newGrade(): Promise<string> {
  const n = ++gradeSeq;
  const [g] = await db
    .insert(grades)
    .values({ organisationId: A.orgId, commodityId: md.commodityId, name: `G-${n}`, code: `G${n}` })
    .returning({ id: grades.id });
  return g.id;
}

async function confirmedOrder(gradeId: string, kgs: string[], price = 30_000) {
  const order = await createSalesOrder(asDb(db), A.ctx, {
    customerId,
    orderDate: "2026-02-01",
    lines: kgs.map((kg) => ({ commodityId: md.commodityId, gradeId, kg, pricePerKgKobo: price })),
  });
  await confirmSalesOrder(asDb(db), A.ctx, { id: order.id });
  return order;
}

async function orderStatus(id: string) {
  const [o] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, id));
  return o.status;
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Seller A" });
  B = await createTestOrg(db, { name: "Seller B" });
  md = await createMasterData(db, A.ctx);
  const [w] = await db
    .insert(warehouses)
    .values({ organisationId: A.orgId, name: "Second Warehouse", capacityKg: "100000.000" })
    .returning({ id: warehouses.id });
  wh2 = w.id;
  supplierId = await createSupplier(db, A.ctx);
  customerId = await createCustomer(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("sales orders", () => {
  it("creates a draft with SO number and half-up line amounts", async () => {
    const gradeId = await newGrade();
    const order = await createSalesOrder(asDb(db), A.ctx, {
      customerId,
      orderDate: "2026-02-01",
      lines: [
        { commodityId: md.commodityId, gradeId, kg: "96.2", pricePerKgKobo: 30_555 },
        { commodityId: md.commodityId, gradeId, kg: "0.333", pricePerKgKobo: 150 },
      ],
    });
    expect(order.status).toBe("draft");
    expect(order.orderNumber).toMatch(/^SO-\d{4}-\d{5}$/);
    // 96200 g × 30555 / 1000 = 2,939,391 ; 333 g × 150 / 1000 = 49.95 → 50
    expect(order.lines.map((l) => l.amountKobo)).toEqual([2_939_391, 50]);
    expect(order.totalAmountKobo).toBe(2_939_441);
    expect(order.lines[0].kg).toBe("96.200");

    const updated = await updateSalesOrder(asDb(db), A.ctx, {
      id: order.id,
      customerId,
      orderDate: "2026-02-02",
      lines: [{ commodityId: md.commodityId, gradeId, kg: "10", pricePerKgKobo: 1_000 }],
    });
    expect(updated.lines).toHaveLength(1);
    expect(updated.totalAmountKobo).toBe(10_000);

    await confirmSalesOrder(asDb(db), A.ctx, { id: order.id });
    await expectCode(
      updateSalesOrder(asDb(db), A.ctx, { id: order.id, customerId, orderDate: "2026-02-02", lines: updated.lines }),
      "ORDER_NOT_DRAFT",
    );
  });

  it("rejects a grade from another commodity and foreign-org customers", async () => {
    const otherMd = await createMasterData(db, A.ctx);
    await expectCode(
      createSalesOrder(asDb(db), A.ctx, {
        customerId,
        orderDate: "2026-02-01",
        lines: [{ commodityId: md.commodityId, gradeId: otherMd.gradeId, kg: "1", pricePerKgKobo: 1 }],
      }),
      "VALIDATION",
    );
    await expectCode(
      createSalesOrder(asDb(db), B.ctx, {
        customerId,
        orderDate: "2026-02-01",
        lines: [{ commodityId: md.commodityId, gradeId: md.gradeId, kg: "1", pricePerKgKobo: 1 }],
      }),
      "NOT_FOUND",
    );
  });

  it("does not allocate draft orders", async () => {
    const gradeId = await newGrade();
    await seedLot({ kg: "10", receivedAt: new Date("2026-01-01"), gradeId });
    const draft = await createSalesOrder(asDb(db), A.ctx, {
      customerId,
      orderDate: "2026-02-01",
      lines: [{ commodityId: md.commodityId, gradeId, kg: "5", pricePerKgKobo: 1 }],
    });
    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, { salesLineId: draft.lines[0].id, mode: "fifo" }),
      "ORDER_NOT_ALLOCATABLE",
    );
  });
});

describe("FIFO allocation", () => {
  it("picks the oldest lots first across warehouses, partial on the last", async () => {
    const gradeId = await newGrade();
    const oldest = await seedLot({ kg: "50", receivedAt: new Date("2026-01-01T08:00:00Z"), gradeId, warehouseId: wh2 });
    const middle = await seedLot({ kg: "50", receivedAt: new Date("2026-01-05T08:00:00Z"), gradeId });
    const newest = await seedLot({ kg: "100", receivedAt: new Date("2026-01-10T08:00:00Z"), gradeId });
    const order = await confirmedOrder(gradeId, ["120"]);

    const rows = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" });
    expect(rows.map((r) => [r.lotId, r.warehouseId, r.kg, r.status])).toEqual([
      [oldest, wh2, "50.000", "reserved"],
      [middle, md.warehouseId, "50.000", "reserved"],
      [newest, md.warehouseId, "20.000", "reserved"],
    ]);
    expect(await orderStatus(order.id)).toBe("allocated");

    const detail = await getSalesOrder(asDb(db), A.ctx, { id: order.id });
    expect(detail.lines[0].reservedKg).toBe("120.000");
    expect(detail.lines[0].remainingKg).toBe("0.000");
    expect(detail.lines[0].fullyAllocated).toBe(true);

    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" }),
      "LINE_FULLY_ALLOCATED",
    );
  });

  it("honours a warehouse filter and member warehouse restrictions", async () => {
    const gradeId = await newGrade();
    await seedLot({ kg: "50", receivedAt: new Date("2026-01-01"), gradeId, warehouseId: wh2 });
    const inMain = await seedLot({ kg: "50", receivedAt: new Date("2026-01-09"), gradeId });
    const order = await confirmedOrder(gradeId, ["30", "30"]);

    const viaFilter = await reserveForSalesLine(asDb(db), A.ctx, {
      salesLineId: order.lines[0].id,
      mode: "fifo",
      warehouseId: md.warehouseId,
    });
    expect(viaFilter.map((r) => r.lotId)).toEqual([inMain]);

    const restricted = { ...A.ctx, restrictions: { ...A.ctx.restrictions, warehouseIds: [md.warehouseId] } };
    await expectCode(
      reserveForSalesLine(asDb(db), restricted, { salesLineId: order.lines[1].id, mode: "fifo", warehouseId: wh2 }),
      "FORBIDDEN_WAREHOUSE",
    );
    // Restricted to main: only 20 kg left there → short.
    await expectCode(
      reserveForSalesLine(asDb(db), restricted, { salesLineId: order.lines[1].id, mode: "fifo" }),
      "INSUFFICIENT_STOCK",
    );
  });

  it("autoAllocateOrder covers every line in one go", async () => {
    const gradeId = await newGrade();
    await seedLot({ kg: "100", receivedAt: new Date("2026-01-01"), gradeId });
    const order = await confirmedOrder(gradeId, ["40", "35.5"]);
    const rows = await autoAllocateOrder(asDb(db), A.ctx, { salesOrderId: order.id });
    expect(rows.map((r) => r.kg).sort()).toEqual(["35.500", "40.000"]);
    expect(await orderStatus(order.id)).toBe("allocated");
  });
});

describe("manual allocation", () => {
  it("validates picks against fresh availability", async () => {
    const gradeId = await newGrade();
    await seedLot({ kg: "40", receivedAt: new Date("2026-01-01"), gradeId });
    const newer = await seedLot({ kg: "60", receivedAt: new Date("2026-01-03"), gradeId, warehouseId: wh2 });
    const otherGrade = await newGrade();
    const wrongLot = await seedLot({ kg: "100", receivedAt: new Date("2026-01-01"), gradeId: otherGrade });
    const order = await confirmedOrder(gradeId, ["50"]);
    const salesLineId = order.lines[0].id;

    // exceeds the lot
    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, {
        salesLineId,
        mode: "manual",
        picks: [{ lotId: newer, warehouseId: wh2, grams: 61_000 }],
      }),
      "INSUFFICIENT_STOCK",
    );
    // Σ picks ≠ requested
    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, {
        salesLineId,
        mode: "manual",
        picks: [{ lotId: newer, warehouseId: wh2, grams: 40_000 }],
      }),
      "ALLOCATION_INVALID",
    );
    // wrong warehouse for the lot
    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, {
        salesLineId,
        mode: "manual",
        picks: [{ lotId: newer, warehouseId: md.warehouseId, grams: 50_000 }],
      }),
      "ALLOCATION_INVALID",
    );
    // lot of a different grade is not a candidate
    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, {
        salesLineId,
        mode: "manual",
        picks: [{ lotId: wrongLot, warehouseId: md.warehouseId, grams: 50_000 }],
      }),
      "ALLOCATION_INVALID",
    );
    expect(await db.select().from(lotAllocations).where(eq(lotAllocations.salesLineId, salesLineId))).toHaveLength(0);

    // valid: newer lot by hand (not FIFO order)
    const rows = await reserveForSalesLine(asDb(db), A.ctx, {
      salesLineId,
      mode: "manual",
      picks: [{ lotId: newer, warehouseId: wh2, grams: 50_000 }],
    });
    expect(rows.map((r) => [r.lotId, r.kg])).toEqual([[newer, "50.000"]]);
  });

  it("zod schema converts kg picks to grams and requires picks for manual", () => {
    const lotId = randomUUID();
    const warehouseId = randomUUID();
    const salesLineId = randomUUID();
    const parsed = reserveInput.parse({ salesLineId, mode: "manual", picks: [{ lotId, warehouseId, kg: "12.345" }] });
    expect(parsed.picks).toEqual([{ lotId, warehouseId, grams: 12_345 }]);
    expect(reserveInput.safeParse({ salesLineId, mode: "manual" }).success).toBe(false);
  });
});

describe("reservations reduce availability", () => {
  it("blocks a second order, and release frees the stock", async () => {
    const gradeId = await newGrade();
    const lot = await seedLot({ kg: "100", receivedAt: new Date("2026-01-01"), gradeId });
    const first = await confirmedOrder(gradeId, ["70"]);
    const second = await confirmedOrder(gradeId, ["50"]);

    const [alloc] = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: first.lines[0].id, mode: "fifo" });
    expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lot, md.warehouseId))).toBe(30_000);
    const avail = await listAvailableLots(asDb(db), A.ctx, { commodityId: md.commodityId, gradeId });
    expect(avail.map((a) => a.availableKg)).toEqual(["30.000"]);

    await expectCode(
      reserveForSalesLine(asDb(db), A.ctx, { salesLineId: second.lines[0].id, mode: "fifo" }),
      "INSUFFICIENT_STOCK",
    );

    const released = await releaseAllocation(asDb(db), A.ctx, { allocationId: alloc.id });
    expect(released.map((r) => r.status)).toEqual(["cancelled"]);
    expect(await orderStatus(first.id)).toBe("confirmed");
    await expectCode(releaseAllocation(asDb(db), A.ctx, { allocationId: alloc.id }), "ALLOCATION_NOT_RESERVED");

    const rows = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: second.lines[0].id, mode: "fifo" });
    expect(rows.map((r) => r.kg)).toEqual(["50.000"]);
    expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lot, md.warehouseId))).toBe(50_000);
  });

  it("cancelling an allocated order releases its reservations", async () => {
    const gradeId = await newGrade();
    const lot = await seedLot({ kg: "20", receivedAt: new Date("2026-01-01"), gradeId });
    const order = await confirmedOrder(gradeId, ["20"]);
    await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" });
    expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lot, md.warehouseId))).toBe(0);

    const cancelled = await cancelSalesOrder(asDb(db), A.ctx, { id: order.id });
    expect(cancelled.status).toBe("cancelled");
    const rows = await db.select().from(lotAllocations).where(eq(lotAllocations.salesLineId, order.lines[0].id));
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
    expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lot, md.warehouseId))).toBe(20_000);
    await expectCode(cancelSalesOrder(asDb(db), A.ctx, { id: order.id }), "ORDER_ALREADY_CANCELLED");
  });

  it("another organisation cannot see or allocate the line", async () => {
    const gradeId = await newGrade();
    await seedLot({ kg: "10", receivedAt: new Date("2026-01-01"), gradeId });
    const order = await confirmedOrder(gradeId, ["5"]);
    await expectCode(
      reserveForSalesLine(asDb(db), B.ctx, { salesLineId: order.lines[0].id, mode: "fifo" }),
      "NOT_FOUND",
    );
    await expectCode(getSalesOrder(asDb(db), B.ctx, { id: order.id }), "NOT_FOUND");
  });
});

describe("OVERSELL under concurrency (DoD)", () => {
  it("two parallel 80 kg reservations on one 100 kg lot over two connections: exactly one wins", async () => {
    const poolA = new Pool({ connectionString: testDbUrl(), max: 1 });
    const poolB = new Pool({ connectionString: testDbUrl(), max: 1 });
    const dbA = drizzle({ client: poolA, schema }) as unknown as DbOrTx;
    const dbB = drizzle({ client: poolB, schema }) as unknown as DbOrTx;
    try {
      for (let round = 0; round < 5; round++) {
        const gradeId = await newGrade();
        const lot = await seedLot({ kg: "100", receivedAt: new Date("2026-01-01"), gradeId });
        const o1 = await confirmedOrder(gradeId, ["80"]);
        const o2 = await confirmedOrder(gradeId, ["80"]);

        const results = await Promise.allSettled([
          reserveForSalesLine(dbA, A.ctx, { salesLineId: o1.lines[0].id, mode: "fifo" }),
          reserveForSalesLine(dbB, A.ctx, { salesLineId: o2.lines[0].id, mode: "fifo" }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        expect(bad[0].reason).toBeInstanceOf(DomainError);
        expect((bad[0].reason as DomainError).code).toBe("INSUFFICIENT_STOCK");

        const reserved = await db
          .select()
          .from(lotAllocations)
          .where(and(eq(lotAllocations.lotId, lot), eq(lotAllocations.status, "reserved")));
        expect(reserved.map((r) => r.kg)).toEqual(["80.000"]);
        expect(await asDb(db).transaction((tx) => availableGrams(tx, A.ctx, lot, md.warehouseId))).toBe(20_000);
      }
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });
});
