import { and, eq, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import type { z } from "zod";

import type { DbOrTx } from "@/db/client";
import { commodities, customers, grades, lots, purchases, suppliers, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { formatNaira } from "@/lib/domain/units";
import {
  CUSTOMER_COLUMNS,
  IMPORT_MAX_ROWS,
  OPENING_STOCK_COLUMNS,
  REQUIRED_COLUMNS,
  SUPPLIER_COLUMNS,
  customerImportRow,
  openingStockImportRow,
  supplierImportRow,
  type CustomerImportRow,
  type ImportInput,
  type ImportKind,
  type OpeningStockImportRow,
  type SupplierImportRow,
} from "@/lib/validation/imports";
import { purchaseCreateInput, receivePurchaseInput } from "@/lib/validation/buying";

import { createCustomer } from "./customers";
import { approvePurchase, createPurchase } from "./purchases";
import { receivePurchase } from "./receiving";
import { assertCan, assertWritable, createSupplier, inTx, type PendingJob } from "./suppliers";

/**
 * CSV import (P4-C): suppliers, customers, opening stock.
 *
 * previewImport → parse + validate EVERY row (zod + reference lookups), return
 *   valid rows and row-level errors. Nothing is written.
 * confirmImport → re-runs the preview server-side (the client is never
 *   trusted), then imports each valid row in its OWN transaction through the
 *   real services, so one bad row never blocks the rest. Per-row outcomes.
 *
 * Row numbers are spreadsheet rows: the header is row 1, first data row is 2.
 * Dedupe (suppliers/customers): same org + case-insensitive name + phone
 * (both blank counts as equal) → skipped with a notice, also within one file.
 * Opening stock: a purchase (status approved; over-guide prices are approved
 * by the importer) + receivePurchase into the named warehouse, so lots,
 * movements and the GRN number come from the same code as a normal receipt.
 * The frozen schema has no purchases.note / is_opening column, so the
 * "OPENING STOCK" marker lives in an audit row on the purchase.
 */

export type ImportError = { row: number; field: string; message: string };
export type PreviewRow<T> = { row: number; data: T; notice?: string };

export type ResolvedOpeningStock = OpeningStockImportRow & {
  commodityId: string;
  gradeId: string;
  warehouseId: string;
  /** Existing supplier id, or null → created on confirm. */
  supplierId: string | null;
};

export type ImportPreview =
  | { kind: "suppliers"; totalRows: number; validRows: PreviewRow<SupplierImportRow>[]; errors: ImportError[] }
  | { kind: "customers"; totalRows: number; validRows: PreviewRow<CustomerImportRow>[]; errors: ImportError[] }
  | { kind: "opening_stock"; totalRows: number; validRows: PreviewRow<ResolvedOpeningStock>[]; errors: ImportError[] };

export type RowOutcome = {
  row: number;
  status: "created" | "skipped" | "failed";
  message: string;
  id?: string;
};

export type ImportResult = {
  kind: ImportKind;
  created: number;
  skipped: number;
  failed: number;
  /** Rows rejected at validation (not attempted). */
  invalid: number;
  outcomes: RowOutcome[];
  errors: ImportError[];
  jobs: PendingJob[];
};

// ── CSV parsing ──────────────────────────────────────────────────────────────

function normaliseHeader(h: string): string {
  return h
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

type RawRow = { row: number; values: Record<string, string> };

function parseCsv(kind: ImportKind, csv: string): { rows: RawRow[]; errors: ImportError[] } {
  let records: string[][];
  try {
    records = parse(csv, { bom: true, relax_column_count: true, trim: true, skip_empty_lines: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read the CSV file";
    return { rows: [], errors: [{ row: 0, field: "file", message }] };
  }
  if (records.length === 0) {
    return { rows: [], errors: [{ row: 0, field: "file", message: "The file is empty" }] };
  }
  const header = records[0].map(normaliseHeader);
  const missing = REQUIRED_COLUMNS[kind].filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: missing.map((c) => ({ row: 1, field: c, message: `Missing column "${c}"` })),
    };
  }
  const rows: RawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec.every((v) => v.trim() === "")) continue;
    const values: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h) values[h] = rec[idx] ?? "";
    });
    rows.push({ row: i + 1, values });
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          field: "file",
          message: `The file has ${rows.length} rows; the limit is ${IMPORT_MAX_ROWS} per file. Split it and import each part.`,
        },
      ],
    };
  }
  if (rows.length === 0) {
    return { rows: [], errors: [{ row: 0, field: "file", message: "The file has a header but no data rows" }] };
  }
  return { rows, errors: [] };
}

/** Pick CSV columns into schema field names. */
function pick<M extends Record<string, string>>(values: Record<string, string>, map: M): Record<keyof M, string> {
  const out = {} as Record<keyof M, string>;
  for (const [field, col] of Object.entries(map) as [keyof M, string][]) out[field] = values[col] ?? "";
  return out;
}

function zodRowErrors(row: number, err: z.ZodError, map: Record<string, string>): ImportError[] {
  return err.issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    return { row, field: map[key] ?? (key || "row"), message: issue.message };
  });
}

function validateRows<S extends z.ZodType>(
  rows: RawRow[],
  schema: S,
  map: Record<string, string>,
): { valid: PreviewRow<z.output<S>>[]; errors: ImportError[] } {
  const valid: PreviewRow<z.output<S>>[] = [];
  const errors: ImportError[] = [];
  for (const r of rows) {
    const parsed = schema.safeParse(pick(r.values, map));
    if (parsed.success) valid.push({ row: r.row, data: parsed.data });
    else errors.push(...zodRowErrors(r.row, parsed.error, map));
  }
  return { valid, errors };
}

// ── dedupe helpers ───────────────────────────────────────────────────────────

const dedupeKey = (name: string, phone: string | null | undefined) =>
  `${name.trim().toLowerCase()}|${phone ?? ""}`;

async function existingSupplierKeys(db: DbOrTx, ctx: OrgContext): Promise<Set<string>> {
  const rows = await db
    .select({ name: suppliers.name, phone: suppliers.phone })
    .from(suppliers)
    .where(eq(suppliers.organisationId, ctx.orgId));
  return new Set(rows.map((r) => dedupeKey(r.name, r.phone)));
}

async function existingCustomerKeys(db: DbOrTx, ctx: OrgContext): Promise<Set<string>> {
  const rows = await db
    .select({ name: customers.name, phone: customers.phone })
    .from(customers)
    .where(eq(customers.organisationId, ctx.orgId));
  return new Set(rows.map((r) => dedupeKey(r.name, r.phone)));
}

function markDuplicates<T extends { name: string; phone?: string | null }>(
  rows: PreviewRow<T>[],
  existing: Set<string>,
  what: string,
): PreviewRow<T>[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const key = dedupeKey(r.data.name, r.data.phone);
    if (existing.has(key)) return { ...r, notice: `A ${what} with this name and phone already exists — will be skipped` };
    if (seen.has(key)) return { ...r, notice: `Duplicate of an earlier row in this file — will be skipped` };
    seen.add(key);
    return r;
  });
}

// ── opening stock reference resolution ───────────────────────────────────────

async function resolveOpeningStock(
  db: DbOrTx,
  ctx: OrgContext,
  rows: PreviewRow<OpeningStockImportRow>[],
): Promise<{ valid: PreviewRow<ResolvedOpeningStock>[]; errors: ImportError[] }> {
  const cRows = await db
    .select({ id: commodities.id, code: commodities.code, active: commodities.active })
    .from(commodities)
    .where(eq(commodities.organisationId, ctx.orgId));
  const gRows = await db
    .select({ id: grades.id, commodityId: grades.commodityId, name: grades.name })
    .from(grades)
    .where(eq(grades.organisationId, ctx.orgId));
  const wRows = await db
    .select({ id: warehouses.id, name: warehouses.name, active: warehouses.active })
    .from(warehouses)
    .where(eq(warehouses.organisationId, ctx.orgId));
  const sRows = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.organisationId, ctx.orgId))
    .orderBy(suppliers.createdAt);

  const lc = (s: string) => s.trim().toLowerCase();
  const commodityByCode = new Map(cRows.map((c) => [lc(c.code), c]));
  const warehouseByName = new Map(wRows.map((w) => [lc(w.name), w]));
  const supplierByName = new Map<string, string>();
  for (const s of sRows) if (!supplierByName.has(lc(s.name))) supplierByName.set(lc(s.name), s.id);

  const valid: PreviewRow<ResolvedOpeningStock>[] = [];
  const errors: ImportError[] = [];
  const C = OPENING_STOCK_COLUMNS;
  for (const r of rows) {
    const rowErrors: ImportError[] = [];
    const commodity = commodityByCode.get(lc(r.data.commodityCode));
    if (!commodity || !commodity.active) {
      rowErrors.push({ row: r.row, field: C.commodityCode, message: `No active commodity with code "${r.data.commodityCode}"` });
    }
    const grade = commodity
      ? gRows.find((g) => g.commodityId === commodity.id && lc(g.name) === lc(r.data.gradeName))
      : undefined;
    if (commodity && !grade) {
      rowErrors.push({ row: r.row, field: C.gradeName, message: `Commodity ${commodity.code} has no grade "${r.data.gradeName}"` });
    }
    const warehouse = warehouseByName.get(lc(r.data.warehouseName));
    if (!warehouse || !warehouse.active) {
      rowErrors.push({ row: r.row, field: C.warehouseName, message: `No active warehouse named "${r.data.warehouseName}"` });
    } else if (ctx.restrictions.warehouseIds !== null && !ctx.restrictions.warehouseIds.includes(warehouse.id)) {
      rowErrors.push({ row: r.row, field: C.warehouseName, message: "You are not assigned to this warehouse" });
    }
    if (rowErrors.length > 0 || !commodity || !grade || !warehouse) {
      errors.push(...rowErrors);
      continue;
    }
    const supplierId = supplierByName.get(lc(r.data.supplierName)) ?? null;
    valid.push({
      row: r.row,
      data: { ...r.data, commodityId: commodity.id, gradeId: grade.id, warehouseId: warehouse.id, supplierId },
      notice: supplierId ? undefined : `New supplier "${r.data.supplierName}" will be created`,
    });
  }
  return { valid, errors };
}

// ── preview ──────────────────────────────────────────────────────────────────

export async function previewImport(db: DbOrTx, ctx: OrgContext, input: ImportInput): Promise<ImportPreview> {
  assertCan(ctx, "import.write");
  const { rows, errors: fileErrors } = parseCsv(input.kind, input.csv);
  const totalRows = rows.length;

  switch (input.kind) {
    case "suppliers": {
      const { valid, errors } = validateRows(rows, supplierImportRow, SUPPLIER_COLUMNS);
      return {
        kind: "suppliers",
        totalRows,
        validRows: markDuplicates(valid, await existingSupplierKeys(db, ctx), "supplier"),
        errors: [...fileErrors, ...errors],
      };
    }
    case "customers": {
      const { valid, errors } = validateRows(rows, customerImportRow, CUSTOMER_COLUMNS);
      return {
        kind: "customers",
        totalRows,
        validRows: markDuplicates(valid, await existingCustomerKeys(db, ctx), "customer"),
        errors: [...fileErrors, ...errors],
      };
    }
    case "opening_stock": {
      const { valid, errors } = validateRows(rows, openingStockImportRow, OPENING_STOCK_COLUMNS);
      const resolved = await resolveOpeningStock(db, ctx, valid);
      return {
        kind: "opening_stock",
        totalRows,
        validRows: resolved.valid,
        errors: [...fileErrors, ...errors, ...resolved.errors].sort((a, b) => a.row - b.row),
      };
    }
  }
}

// ── confirm ──────────────────────────────────────────────────────────────────

function failureMessage(err: unknown): string {
  if (err instanceof DomainError) return err.message && err.message !== err.code ? err.message : err.code;
  console.error("[imports] row failed", err);
  return "Unexpected error — row not imported";
}

/** Lagos noon on the given calendar date (keeps the date stable in any TZ rendering). */
function lagosNoon(dateIso: string): Date {
  return new Date(`${dateIso}T12:00:00+01:00`);
}

async function importOpeningStockRow(
  db: DbOrTx,
  ctx: OrgContext,
  r: PreviewRow<ResolvedOpeningStock>,
): Promise<{ outcome: RowOutcome; jobs: PendingJob[] }> {
  const d = r.data;
  return inTx(db, async (tx) => {
    // Supplier: found by name at preview time, or looked up again (an earlier
    // row in this file may have created it), else created.
    let supplierId = d.supplierId;
    let createdSupplier = false;
    if (!supplierId) {
      const [found] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.organisationId, ctx.orgId),
            sql`lower(trim(${suppliers.name})) = ${d.supplierName.trim().toLowerCase()}`,
          ),
        )
        .orderBy(suppliers.createdAt)
        .limit(1);
      if (found) supplierId = found.id;
      else {
        const s = await createSupplier(tx, ctx, {
          type: "farmer",
          name: d.supplierName,
          phone: null,
          village: null,
          lga: null,
          state: null,
          bankName: null,
          bankAccountNumber: null,
          bankAccountName: null,
          idNote: null,
          photoKey: null,
        });
        supplierId = s.id;
        createdSupplier = true;
      }
    }

    const { purchase } = await createPurchase(
      tx,
      ctx,
      purchaseCreateInput.parse({
        supplierId,
        buyingPointId: null,
        purchaseDate: d.receivedDate,
        lines: [
          {
            commodityId: d.commodityId,
            gradeId: d.gradeId,
            bagTypeId: null,
            bags: d.bags,
            grossKg: d.netKg,
            moisturePercent: null,
            pricePerKgKobo: d.pricePerKgKobo,
            deductions: [],
          },
        ],
      }),
    );
    // Opening balances are historical facts: an over-guide price is approved
    // by the importer (owner/manager hold purchase.approve).
    if (purchase.status === "pending_approval") await approvePurchase(tx, ctx, { id: purchase.id });

    const received = await receivePurchase(
      tx,
      ctx,
      receivePurchaseInput.parse({ purchaseId: purchase.id, warehouseId: d.warehouseId, sendSms: false }),
    );

    // Age the stock from its real received date (ageing bands / old-stock
    // alerts read lots.received_at). Movements keep the import timestamp —
    // the ledger records when stock entered the system.
    const receivedAt = lagosNoon(d.receivedDate);
    const lotIds = received.lots.map((l) => l.id);
    for (const lotId of lotIds) {
      await tx
        .update(lots)
        .set({ receivedAt, updatedAt: new Date() })
        .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, lotId)));
    }
    await tx
      .update(purchases)
      .set({ receivedAt, updatedAt: new Date() })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, purchase.id)));

    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "purchases",
      recordId: purchase.id,
      after: {
        note: "OPENING STOCK",
        source: "csv-import",
        row: r.row,
        grnNumber: received.grnNumber,
        lotIds,
        receivedDate: d.receivedDate,
      },
    });

    return {
      outcome: {
        row: r.row,
        status: "created",
        id: purchase.id,
        message: `${received.grnNumber}: ${d.netKg} kg ${d.commodityCode} ${d.gradeName} into ${d.warehouseName} at ${formatNaira(d.pricePerKgKobo)}/kg${createdSupplier ? ` (new supplier ${d.supplierName})` : ""}`,
      },
      jobs: received.jobs,
    };
  });
}

/**
 * Import every valid row. Callers enqueue `result.jobs` after this returns
 * (each row committed in its own transaction).
 */
export async function confirmImport(db: DbOrTx, ctx: OrgContext, input: ImportInput): Promise<ImportResult> {
  assertCan(ctx, "import.write");
  assertWritable(ctx);
  const preview = await previewImport(db, ctx, input);
  const outcomes: RowOutcome[] = [];
  const jobs: PendingJob[] = [];

  if (preview.kind === "suppliers") {
    const existing = await existingSupplierKeys(db, ctx);
    for (const r of preview.validRows) {
      const key = dedupeKey(r.data.name, r.data.phone);
      if (existing.has(key)) {
        outcomes.push({ row: r.row, status: "skipped", message: `Supplier "${r.data.name}" already exists` });
        continue;
      }
      try {
        const s = await createSupplier(db, ctx, r.data);
        existing.add(key);
        outcomes.push({ row: r.row, status: "created", id: s.id, message: `Supplier "${s.name}" created` });
      } catch (err) {
        outcomes.push({ row: r.row, status: "failed", message: failureMessage(err) });
      }
    }
  } else if (preview.kind === "customers") {
    const existing = await existingCustomerKeys(db, ctx);
    for (const r of preview.validRows) {
      const key = dedupeKey(r.data.name, r.data.phone);
      if (existing.has(key)) {
        outcomes.push({ row: r.row, status: "skipped", message: `Customer "${r.data.name}" already exists` });
        continue;
      }
      try {
        const c = await createCustomer(db, ctx, r.data);
        existing.add(key);
        outcomes.push({ row: r.row, status: "created", id: c.id, message: `Customer "${c.name}" created` });
      } catch (err) {
        outcomes.push({ row: r.row, status: "failed", message: failureMessage(err) });
      }
    }
  } else {
    for (const r of preview.validRows) {
      try {
        const res = await importOpeningStockRow(db, ctx, r);
        outcomes.push(res.outcome);
        jobs.push(...res.jobs);
      } catch (err) {
        outcomes.push({ row: r.row, status: "failed", message: failureMessage(err) });
      }
    }
  }

  const invalidRows = new Set(preview.errors.filter((e) => e.row > 1).map((e) => e.row));
  return {
    kind: preview.kind,
    created: outcomes.filter((o) => o.status === "created").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    invalid: invalidRows.size,
    outcomes,
    errors: preview.errors,
    jobs,
  };
}
