import { z } from "zod";

import { supplierInput } from "./buying";
import { zDateISO, zKgString, zPhoneNg } from "./common";
import { customerInput } from "./selling";

/**
 * CSV import schemas (P4-C). Row schemas REUSE the module schemas
 * (supplierInput, customerInput) so imported rows obey exactly the rules the
 * forms do. CSV column names are snake_case; `*_COLUMNS` maps each schema
 * field back to its column for row-level error messages.
 */

export const IMPORT_MAX_ROWS = 2000;
/** Server actions accept ~1 MB bodies by default; keep the CSV under that. */
export const IMPORT_MAX_CHARS = 900_000;

export const importKindEnum = z.enum(["suppliers", "customers", "opening_stock"]);
export type ImportKind = z.output<typeof importKindEnum>;

export const importInput = z.object({
  kind: importKindEnum,
  csv: z
    .string()
    .min(1, "Choose a CSV file")
    .max(IMPORT_MAX_CHARS, "File is too large — split it into files of at most 2000 rows"),
});
export type ImportInput = z.output<typeof importInput>;

// ── column ↔ field maps ──────────────────────────────────────────────────────

export const SUPPLIER_COLUMNS = {
  name: "name",
  type: "type",
  phone: "phone",
  village: "village",
  lga: "lga",
  state: "state",
  bankName: "bank_name",
  bankAccountNumber: "bank_account_number",
  bankAccountName: "bank_account_name",
} as const;

export const CUSTOMER_COLUMNS = {
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  state: "state",
} as const;

export const OPENING_STOCK_COLUMNS = {
  supplierName: "supplier_name_or_new",
  commodityCode: "commodity_code",
  gradeName: "grade_name",
  warehouseName: "warehouse_name",
  bags: "bags",
  netKg: "net_kg",
  pricePerKgKobo: "price_per_kg_naira",
  receivedDate: "received_date",
} as const;

export const REQUIRED_COLUMNS: Record<ImportKind, readonly string[]> = {
  suppliers: ["name"],
  customers: ["name"],
  opening_stock: Object.values(OPENING_STOCK_COLUMNS),
};

export const TEMPLATE_HEADERS: Record<ImportKind, readonly string[]> = {
  suppliers: Object.values(SUPPLIER_COLUMNS),
  customers: Object.values(CUSTOMER_COLUMNS),
  opening_stock: Object.values(OPENING_STOCK_COLUMNS),
};

// ── row schemas ──────────────────────────────────────────────────────────────

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Supplier row: CSV `type` defaults to farmer when blank; everything else = supplierInput. */
export const supplierImportRow = z.preprocess((raw) => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.trim().toLowerCase() : r.type;
  return { ...r, type: type === "" || type === undefined ? "farmer" : type };
}, supplierInput);
export type SupplierImportRow = z.output<typeof supplierImportRow>;

/** Customer row: customerInput with the phone normalised like suppliers (so dedupe matches). */
export const customerImportRow = customerInput.extend({
  phone: z.preprocess(blankToUndef, zPhoneNg.optional()).transform((v) => v ?? null),
});
export type CustomerImportRow = z.output<typeof customerImportRow>;

/** "1,250.50" naira → 125050 kobo, exact (no float). */
export const zNairaToKobo = z
  .string()
  .trim()
  .transform((s) => s.replace(/,/g, "").replace(/^₦/, ""))
  .pipe(z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter a naira amount (up to 2 decimals)"))
  .transform((s) => {
    const [whole, frac = ""] = s.split(".");
    return Number.parseInt(whole, 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  });

export const openingStockImportRow = z.object({
  supplierName: z.string().trim().min(1, "Supplier name is required").max(200),
  commodityCode: z.string().trim().min(1, "Commodity code is required").max(50),
  gradeName: z.string().trim().min(1, "Grade name is required").max(100),
  warehouseName: z.string().trim().min(1, "Warehouse name is required").max(200),
  bags: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? 0 : typeof v === "string" ? Number(v.trim()) : v),
    z.number("Bags must be a whole number").int("Bags must be a whole number").min(0).max(1_000_000),
  ),
  netKg: zKgString.refine((s) => Number(s) > 0, "Net kg must be greater than zero"),
  pricePerKgKobo: zNairaToKobo,
  receivedDate: zDateISO,
});
export type OpeningStockImportRow = z.output<typeof openingStockImportRow>;
