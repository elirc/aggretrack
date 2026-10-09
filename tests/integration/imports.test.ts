import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { auditLog, customers, lots, purchaseLines, purchases, stockMovements, suppliers } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { confirmImport, previewImport } from "@/lib/services/imports";
import { lagosYear } from "@/lib/services/numbering";
import { lotOnHand } from "@/lib/services/stockCore";
import {
  createCustomer,
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { commodities, grades, warehouses } from "@/db/schema";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;
let commodityCode: string;
let gradeName: string;
let warehouseName: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const YEAR = lagosYear();

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

const csv = (...lines: string[]) => lines.join("\n");

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  A = await createTestOrg(db);
  md = await createMasterData(db, A.ctx);
  [{ code: commodityCode }] = await db.select({ code: commodities.code }).from(commodities).where(eq(commodities.id, md.commodityId));
  [{ name: gradeName }] = await db.select({ name: grades.name }).from(grades).where(eq(grades.id, md.gradeId));
  [{ name: warehouseName }] = await db.select({ name: warehouses.name }).from(warehouses).where(eq(warehouses.id, md.warehouseId));
});

afterAll(async () => {
  await t.close();
});

describe("preview", () => {
  it("reports row-level errors with spreadsheet row numbers and keeps valid rows", async () => {
    const p = await previewImport(asDb(db), A.ctx, {
      kind: "suppliers",
      csv: csv(
        "Name,Type,Phone,Village,LGA,State,Bank Account Number",
        "Musa Bello,farmer,08031234567,Kwadon,Akko,Gombe,",
        "Bad Phone,farmer,12345,,,,",
        ",agent,08031234568,,,,",
        "Wrong Type,trader,,,,,",
        "",
        "Bad Account,,,,,,12345",
        "Ada Coop,cooperative,+2348031234569,,,,0123456789",
      ),
    });
    expect(p.kind).toBe("suppliers");
    expect(p.totalRows).toBe(6);
    expect(p.validRows.map((r) => r.row)).toEqual([2, 8]);
    expect(p.validRows[0].data).toMatchObject({ name: "Musa Bello", type: "farmer", phone: "2348031234567" });
    expect(p.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, field: "phone" }),
        expect.objectContaining({ row: 4, field: "name" }),
        expect.objectContaining({ row: 5, field: "type" }),
        expect.objectContaining({ row: 7, field: "bank_account_number" }),
      ]),
    );
    expect(p.errors).toHaveLength(4);
    // Nothing written by a preview.
    expect(await db.select().from(suppliers).where(eq(suppliers.organisationId, A.orgId))).toHaveLength(0);
  });

  it("missing required columns, empty files and >2000 rows are file-level errors", async () => {
    const missing = await previewImport(asDb(db), A.ctx, { kind: "opening_stock", csv: "supplier_name_or_new,bags\nX,1" });
    expect(missing.validRows).toHaveLength(0);
    expect(missing.errors.every((e) => e.row === 1)).toBe(true);
    expect(missing.errors.map((e) => e.field)).toContain("net_kg");

    const empty = await previewImport(asDb(db), A.ctx, { kind: "customers", csv: "name,phone\n" });
    expect(empty.errors[0]).toMatchObject({ row: 0, field: "file" });

    const big = ["name", ...Array.from({ length: 2001 }, (_, i) => `Customer ${i}`)].join("\n");
    const tooBig = await previewImport(asDb(db), A.ctx, { kind: "customers", csv: big });
    expect(tooBig.validRows).toHaveLength(0);
    expect(tooBig.errors[0].message).toMatch(/2000/);
  });

  it("opening stock: unknown commodity / grade / warehouse and bad numbers flagged per row", async () => {
    const p = await previewImport(asDb(db), A.ctx, {
      kind: "opening_stock",
      csv: csv(
        "supplier_name_or_new,commodity_code,grade_name,warehouse_name,bags,net_kg,price_per_kg_naira,received_date",
        `New Farmer,${commodityCode},${gradeName},${warehouseName},10,995.5,"1,250.50",2026-07-01`,
        `New Farmer,NOPE,${gradeName},${warehouseName},10,100,450,2026-07-01`,
        `New Farmer,${commodityCode},Grade Z,${warehouseName},10,100,450,2026-07-01`,
        `New Farmer,${commodityCode},${gradeName},Nowhere,10,100,450,2026-07-01`,
        `New Farmer,${commodityCode},${gradeName},${warehouseName},ten,0,4.505,2026-02-30`,
      ),
    });
    expect(p.kind).toBe("opening_stock");
    expect(p.validRows.map((r) => r.row)).toEqual([2]);
    const row2 = p.validRows[0];
    if (p.kind !== "opening_stock") throw new Error("kind");
    expect(p.validRows[0].data).toMatchObject({ pricePerKgKobo: 125050, netKg: "995.5", bags: 10, supplierId: null });
    expect(row2.notice).toMatch(/New supplier/);
    const byRow = (r: number) => p.errors.filter((e) => e.row === r).map((e) => e.field).sort();
    expect(byRow(3)).toEqual(["commodity_code"]);
    expect(byRow(4)).toEqual(["grade_name"]);
    expect(byRow(5)).toEqual(["warehouse_name"]);
    expect(byRow(6)).toEqual(["bags", "net_kg", "price_per_kg_naira", "received_date"]);
  });
});

describe("confirm", () => {
  it("imports suppliers, skipping duplicates (existing + within the file)", async () => {
    await createSupplier(db, A.ctx, { name: "Musa Bello", phone: "2348031234567" });
    const res = await confirmImport(asDb(db), A.ctx, {
      kind: "suppliers",
      csv: csv(
        "name,type,phone,state",
        "musa bello,farmer,08031234567,Gombe", // existing (case-insensitive name + normalised phone)
        "Musa Bello,farmer,08039999999,Gombe", // same name, different phone → new
        "Hauwa Ali,agent,,Bauchi",
        "Hauwa Ali,agent,,Bauchi", // duplicate in file
        "Broken,farmer,999,",
      ),
    });
    expect(res).toMatchObject({ kind: "suppliers", created: 2, skipped: 2, failed: 0, invalid: 1 });
    expect(res.outcomes.map((o) => [o.row, o.status])).toEqual([
      [2, "skipped"],
      [3, "created"],
      [4, "created"],
      [5, "skipped"],
    ]);
    const rows = await db.select().from(suppliers).where(eq(suppliers.organisationId, A.orgId));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.name === "Hauwa Ali")).toMatchObject({ type: "agent", state: "Bauchi", phone: null });
  });

  it("imports customers with dedupe by name + phone", async () => {
    await createCustomer(db, A.ctx, { name: "Lagos Mills", phone: "2348021112222" });
    const res = await confirmImport(asDb(db), A.ctx, {
      kind: "customers",
      csv: csv(
        "name,phone,email,address,state",
        "Lagos Mills,0802 111 2222,,,Lagos",
        "Kano Feeds,08033334444,buy@kanofeeds.ng,12 Bompai Rd,Kano",
        "Bad Email,,not-an-email,,",
      ),
    });
    expect(res).toMatchObject({ created: 1, skipped: 1, failed: 0, invalid: 1 });
    const rows = await db.select().from(customers).where(eq(customers.organisationId, A.orgId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Kano Feeds", "Lagos Mills"]);
    expect(rows.find((r) => r.name === "Kano Feeds")).toMatchObject({
      phone: "2348033334444",
      email: "buy@kanofeeds.ng",
      state: "Kano",
    });
  });

  it("opening stock → approved+received purchase, lot, stock on hand = net kg, numbered GRN", async () => {
    const existingSupplier = await createSupplier(db, A.ctx, { name: "Existing Farmer" });
    const res = await confirmImport(asDb(db), A.ctx, {
      kind: "opening_stock",
      csv: csv(
        "supplier_name_or_new,commodity_code,grade_name,warehouse_name,bags,net_kg,price_per_kg_naira,received_date",
        `existing farmer,${commodityCode.toLowerCase()},${gradeName},${warehouseName},10,995.5,450,2026-07-01`,
        `Brand New Farmer,${commodityCode},${gradeName},${warehouseName},4,400,"1,200.25",2026-08-15`,
        `brand new farmer,${commodityCode},${gradeName},${warehouseName},1,50,500,2026-08-16`,
      ),
    });
    expect(res).toMatchObject({ created: 3, skipped: 0, failed: 0, invalid: 0 });
    expect(res.jobs.filter((j) => j.name === "document.generate")).toHaveLength(3);

    const ps = await db.select().from(purchases).where(eq(purchases.organisationId, A.orgId)).orderBy(purchases.grnNumber);
    expect(ps).toHaveLength(3);
    expect(ps.map((p) => p.grnNumber)).toEqual([`GRN-${YEAR}-00001`, `GRN-${YEAR}-00002`, `GRN-${YEAR}-00003`]);
    expect(ps.every((p) => p.status === "received" && p.receivedWarehouseId === md.warehouseId)).toBe(true);

    const first = ps.find((p) => p.supplierId === existingSupplier)!;
    expect(first.purchaseDate).toBe("2026-07-01");
    expect(first.totalAmountKobo).toBe(995.5 * 45000);
    const [line] = await db.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, first.id));
    expect(line).toMatchObject({ netKg: "995.500", grossKg: "995.500", bags: 10, pricePerKgKobo: 45000 });

    const [lot] = await db.select().from(lots).where(eq(lots.purchaseLineId, line.id));
    expect(lot).toBeDefined();
    expect(lot.originalKg).toBe("995.500");
    expect(lot.receivedAt.toISOString()).toBe("2026-07-01T11:00:00.000Z");
    expect(await lotOnHand(asDb(db), A.ctx, lot.id)).toEqual({ grams: kgToGrams("995.5"), bags: 10 });
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.lotId, lot.id));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "receive", warehouseId: md.warehouseId });

    // One new supplier created for both "Brand New Farmer" rows.
    const sups = await db.select().from(suppliers).where(eq(suppliers.organisationId, A.orgId));
    expect(sups.map((s) => s.name).sort()).toEqual(["Brand New Farmer", "Existing Farmer"]);
    const bnf = sups.find((s) => s.name === "Brand New Farmer")!;
    expect(ps.filter((p) => p.supplierId === bnf.id)).toHaveLength(2);
    expect(ps.find((p) => p.purchaseDate === "2026-08-15")?.totalAmountKobo).toBe(400 * 120025);

    // OPENING STOCK marker recorded in the audit log.
    const marks = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organisationId, A.orgId), eq(auditLog.tableName, "purchases"), eq(auditLog.recordId, first.id)));
    expect(marks.some((m) => (m.after as { note?: string } | null)?.note === "OPENING STOCK")).toBe(true);
  });

  it("is blocked when the organisation is read-only", async () => {
    await expectCode(
      confirmImport(asDb(db), { ...A.ctx, readOnly: true }, { kind: "customers", csv: "name\nX" }),
      "READ_ONLY",
    );
  });
});

describe("cross-org isolation", () => {
  it("never resolves or dedupes against another org's data", async () => {
    const B = await createTestOrg(db);
    await createSupplier(db, A.ctx, { name: "Shared Name", phone: "2348030000001" });

    // A's warehouse / commodity names are invisible to B.
    const p = await previewImport(asDb(db), B.ctx, {
      kind: "opening_stock",
      csv: csv(
        "supplier_name_or_new,commodity_code,grade_name,warehouse_name,bags,net_kg,price_per_kg_naira,received_date",
        `Shared Name,${commodityCode},${gradeName},${warehouseName},1,10,100,2026-07-01`,
      ),
    });
    expect(p.validRows).toHaveLength(0);
    expect(p.errors.map((e) => e.field).sort()).toEqual(["commodity_code", "warehouse_name"]);

    // Same name+phone as A's supplier is NOT a duplicate inside B.
    const res = await confirmImport(asDb(db), B.ctx, {
      kind: "suppliers",
      csv: csv("name,phone", "Shared Name,08030000001"),
    });
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    expect(await db.select().from(suppliers).where(eq(suppliers.organisationId, A.orgId))).toHaveLength(1);
    expect(await db.select().from(suppliers).where(eq(suppliers.organisationId, B.orgId))).toHaveLength(1);
    expect(await db.select().from(purchases).where(eq(purchases.organisationId, B.orgId))).toHaveLength(0);
  });
});
