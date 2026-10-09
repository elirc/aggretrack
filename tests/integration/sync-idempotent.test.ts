import { randomUUID } from "node:crypto";

import { and, count, eq, sum } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import { dispatches, documentCounters, lots, purchases, stockMovements } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { kgToGrams } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { reserveForSalesLine } from "@/lib/services/allocation";
import { confirmSalesOrder, createSalesOrder } from "@/lib/services/salesOrders";
import type { PendingJob } from "@/lib/services/suppliers";
import { processSyncBatch, type SyncDeps, type SyncOpResult } from "@/lib/services/sync";
import {
  createCustomer,
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";

/**
 * DoD (SPEC): replaying the same offline purchase twice creates one purchase.
 * Plus receipt + dispatch replay safety and per-op isolation in a mixed batch.
 */

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;
let supplierId: string;
let customerId: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

const enqueued: PendingJob[] = [];
const sellingJobs: { queue: string; data: object }[] = [];
const deps: SyncDeps = {
  enqueueJobs: async (jobs) => {
    enqueued.push(...jobs);
  },
  selling: {
    enqueue: async (queue, data) => {
      sellingJobs.push({ queue, data });
      return "job";
    },
  },
};

const sync = (ops: unknown[], ctx: OrgContext = A.ctx) => processSyncBatch(asDb(db), ctx, ops, deps);

function purchasePayload(lineKg = "500", pricePerKgKobo = 30_000) {
  return {
    supplierId,
    buyingPointId: md.buyingPointId,
    purchaseDate: "2026-10-05",
    saveAsDraft: false,
    clientCreatedAt: new Date().toISOString(),
    lines: [
      {
        id: randomUUID(),
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        bagTypeId: null,
        bags: 5,
        grossKg: lineKg,
        moisturePercent: null,
        pricePerKgKobo,
        deductions: [],
      },
    ],
  };
}

const purchaseOp = (clientId: string, payload = purchasePayload()) => ({
  clientId,
  kind: "purchase",
  payload,
  orgId: A.orgId,
});

async function purchaseCount(id?: string) {
  const where = id
    ? and(eq(purchases.organisationId, A.orgId), eq(purchases.id, id))
    : eq(purchases.organisationId, A.orgId);
  const [r] = await db.select({ n: count() }).from(purchases).where(where);
  return r.n;
}

async function poCounter() {
  const rows = await db
    .select({ last: documentCounters.lastNumber })
    .from(documentCounters)
    .where(and(eq(documentCounters.organisationId, A.orgId), eq(documentCounters.docType, "po")));
  return rows[0]?.last ?? 0;
}

async function onHandGrams(): Promise<number> {
  const [r] = await db
    .select({ s: sum(stockMovements.kg) })
    .from(stockMovements)
    .where(eq(stockMovements.organisationId, A.orgId));
  return kgToGrams(r.s ?? "0");
}

function statuses(rs: SyncOpResult[]) {
  return rs.map((r) => r.status);
}

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  enqueued.length = 0;
  sellingJobs.length = 0;
  A = await createTestOrg(db, { name: "Sync A" });
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
  customerId = await createCustomer(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/sync — purchases", () => {
  it("same purchase op twice in ONE batch → one purchase, one PO number consumed", async () => {
    const id = randomUUID();
    const payload = purchasePayload();
    const res = await sync([purchaseOp(id, payload), purchaseOp(id, payload)]);

    expect(res.orgId).toBe(A.orgId);
    expect(statuses(res.results)).toEqual(["applied", "duplicate"]);
    expect(res.results.every((r) => r.clientId === id)).toBe(true);
    expect(await purchaseCount()).toBe(1);
    expect(await poCounter()).toBe(1);

    const [p] = await db.select().from(purchases).where(eq(purchases.id, id));
    expect(p.createdOffline).toBe(true);
    expect(p.purchaseNumber).toMatch(/^PO-\d{4}-00001$/);
    const r0 = res.results[0];
    const r1 = res.results[1];
    if (r0.status === "error" || r1.status === "error") throw new Error("unexpected error");
    expect(r1.ref?.number).toBe(r0.ref?.number);
  });

  it("same purchase op in TWO sequential batches → second is duplicate, still one row", async () => {
    const id = randomUUID();
    const payload = purchasePayload();
    const first = await sync([purchaseOp(id, payload)]);
    const second = await sync([purchaseOp(id, payload)]);

    expect(statuses(first.results)).toEqual(["applied"]);
    expect(statuses(second.results)).toEqual(["duplicate"]);
    expect(await purchaseCount()).toBe(1);
    expect(await poCounter()).toBe(1);

    // The next distinct purchase takes number 2 — the replay consumed nothing.
    const other = await sync([purchaseOp(randomUUID())]);
    expect(statuses(other.results)).toEqual(["applied"]);
    expect(await poCounter()).toBe(2);
  });

  it("whole-batch replay of a mixed purchase batch is safe", async () => {
    const ops = [purchaseOp(randomUUID()), purchaseOp(randomUUID()), purchaseOp(randomUUID())];
    const a = await sync(ops);
    const b = await sync(ops);
    expect(statuses(a.results)).toEqual(["applied", "applied", "applied"]);
    expect(statuses(b.results)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(await purchaseCount()).toBe(3);
    expect(await poCounter()).toBe(3);
  });
});

describe("POST /api/sync — receipts", () => {
  it("receipt replay → duplicate, stock and lots unchanged after the second apply", async () => {
    const pid = randomUUID();
    const receipt = {
      clientId: randomUUID(),
      kind: "receipt",
      payload: { purchaseId: pid, warehouseId: md.warehouseId, binId: md.binId, sendSms: false },
      orgId: A.orgId,
    };
    // Purchase + its receipt travel together in one batch (applied in order).
    const first = await sync([purchaseOp(pid, purchasePayload("500")), receipt]);
    expect(statuses(first.results)).toEqual(["applied", "applied"]);
    expect(await onHandGrams()).toBe(500_000);
    const lotsAfterFirst = await db.select({ n: count() }).from(lots).where(eq(lots.organisationId, A.orgId));
    const grnJobs = enqueued.filter((j) => j.name === QUEUES.DOCUMENT_GENERATE).length;
    expect(grnJobs).toBe(1);

    const replay = await sync([purchaseOp(pid, purchasePayload("500")), receipt]);
    expect(statuses(replay.results)).toEqual(["duplicate", "duplicate"]);
    expect(await onHandGrams()).toBe(500_000);
    const lotsAfterReplay = await db.select({ n: count() }).from(lots).where(eq(lots.organisationId, A.orgId));
    expect(lotsAfterReplay[0].n).toBe(lotsAfterFirst[0].n);
    expect(enqueued.filter((j) => j.name === QUEUES.DOCUMENT_GENERATE).length).toBe(1); // no second GRN job

    const [p] = await db.select().from(purchases).where(eq(purchases.id, pid));
    expect(p.status).toBe("received");
    expect(p.grnNumber).toMatch(/^GRN-\d{4}-00001$/);
  });
});

describe("POST /api/sync — dispatches", () => {
  async function allocatedOrder() {
    const pid = randomUUID();
    const r = await sync([
      purchaseOp(pid, purchasePayload("300")),
      { clientId: randomUUID(), kind: "receipt", payload: { purchaseId: pid, warehouseId: md.warehouseId }, orgId: A.orgId },
    ]);
    expect(statuses(r.results)).toEqual(["applied", "applied"]);
    const order = await createSalesOrder(asDb(db), A.ctx, {
      customerId,
      orderDate: "2026-10-06",
      lines: [{ commodityId: md.commodityId, gradeId: md.gradeId, kg: "200", pricePerKgKobo: 40_000 }],
    });
    await confirmSalesOrder(asDb(db), A.ctx, { id: order.id });
    const allocations = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" });
    return { order, allocations };
  }

  it("dispatch replay → one dispatch, stock leaves once", async () => {
    const { order, allocations } = await allocatedOrder();
    const op = {
      clientId: randomUUID(),
      kind: "dispatch",
      payload: { salesOrderId: order.id, allocationIds: allocations.map((a) => a.id), vehicleId: md.vehicleId, driverId: null },
      orgId: A.orgId,
    };
    const first = await sync([op]);
    expect(statuses(first.results)).toEqual(["applied"]);
    expect(await onHandGrams()).toBe(100_000);

    const replayInBatch = await sync([op, op]);
    expect(statuses(replayInBatch.results)).toEqual(["duplicate", "duplicate"]);
    const [d] = await db.select({ n: count() }).from(dispatches).where(eq(dispatches.organisationId, A.orgId));
    expect(d.n).toBe(1);
    expect(await onHandGrams()).toBe(100_000);
    expect(sellingJobs.length).toBe(1); // one waybill PDF job

    const [row] = await db.select().from(dispatches).where(eq(dispatches.id, op.clientId));
    expect(row.dispatchedKg).toBe("200.000");
  });

  it("dispatch whose clientId belongs to another org → error CONFLICT, nothing written", async () => {
    const { order, allocations } = await allocatedOrder();
    const op = {
      clientId: randomUUID(),
      kind: "dispatch",
      payload: { salesOrderId: order.id, allocationIds: allocations.map((a) => a.id) },
    };
    expect(statuses((await sync([op])).results)).toEqual(["applied"]);

    const B = await createTestOrg(db, { name: "Sync B" });
    const res = await sync([op], B.ctx);
    expect(res.results[0]).toMatchObject({ clientId: op.clientId, status: "error" });
    const r = res.results[0];
    if (r.status !== "error") throw new Error("expected error");
    expect(["CONFLICT", "NOT_FOUND"]).toContain(r.code);
  });
});

describe("POST /api/sync — isolation and guards", () => {
  it("mixed batch with invalid ops → the valid ones still apply", async () => {
    const good1 = randomUUID();
    const good2 = randomUUID();
    const badPayload = randomUUID();
    const res = await sync([
      purchaseOp(good1),
      { clientId: badPayload, kind: "purchase", payload: { ...purchasePayload(), supplierId: "not-a-uuid" } },
      { clientId: randomUUID(), kind: "teleport", payload: {} },
      { kind: "purchase", payload: purchasePayload() }, // no clientId
      { clientId: randomUUID(), kind: "purchase", payload: { ...purchasePayload(), supplierId: randomUUID() } }, // unknown supplier
      { clientId: randomUUID(), kind: "receipt", payload: { purchaseId: randomUUID(), warehouseId: md.warehouseId } }, // missing purchase
      purchaseOp(good2),
    ]);

    expect(statuses(res.results)).toEqual(["applied", "error", "error", "error", "error", "error", "applied"]);
    const bad = res.results[1];
    if (bad.status !== "error") throw new Error("expected error");
    expect(bad.code).toBe("VALIDATION");
    expect(bad.clientId).toBe(badPayload);
    expect(res.results[3].clientId).toBe("#3");
    expect(await purchaseCount(good1)).toBe(1);
    expect(await purchaseCount(good2)).toBe(1);
    expect(await purchaseCount()).toBe(2);
    // Failed ops rolled back their own tx: only two PO numbers consumed.
    expect(await poCounter()).toBe(2);
  });

  it("read-only org → READ_ONLY per op, nothing written", async () => {
    const res = await sync([purchaseOp(randomUUID())], { ...A.ctx, readOnly: true });
    expect(res.results[0]).toMatchObject({ status: "error", code: "READ_ONLY" });
    expect(await purchaseCount()).toBe(0);
  });

  it("permission per kind: warehouse role cannot sync purchases or dispatches but can receive", async () => {
    const wh: OrgContext = { ...A.ctx, role: "warehouse" };
    const pid = randomUUID();
    const res = await sync([
      purchaseOp(pid),
      { clientId: randomUUID(), kind: "dispatch", payload: { salesOrderId: randomUUID(), allocationIds: [randomUUID()] } },
    ], wh);
    expect(res.results.map((r) => (r.status === "error" ? r.code : r.status))).toEqual(["FORBIDDEN", "FORBIDDEN"]);

    // Owner creates the purchase; the warehouse keeper receives it via sync.
    expect(statuses((await sync([purchaseOp(pid)])).results)).toEqual(["applied"]);
    const rcv = await sync([{ clientId: randomUUID(), kind: "receipt", payload: { purchaseId: pid, warehouseId: md.warehouseId } }], wh);
    expect(statuses(rcv.results)).toEqual(["applied"]);
  });

  it("op queued under another org → ORG_MISMATCH", async () => {
    const res = await sync([{ ...purchaseOp(randomUUID()), orgId: randomUUID() }]);
    expect(res.results[0]).toMatchObject({ status: "error", code: "ORG_MISMATCH" });
    expect(await purchaseCount()).toBe(0);
  });
});
