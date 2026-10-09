import { z } from "zod";

import { zDateISO, zKgString, zKobo, zPage, zPageSize, zPhoneNg, zUuid } from "./common";

/**
 * Buying module schemas (P2-A). Shared by server actions, forms and the
 * offline sync endpoint — the sync route must parse with THESE schemas.
 */

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

/** Optional free text: trims, "" / undefined → null. */
const zOptText = (max = 500) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : emptyToNull(v)),
    z.string().max(max).nullable(),
  );

const zOptPhone = z.preprocess(emptyToNull, zPhoneNg.nullable());
const zOptUuid = z.preprocess(emptyToNull, zUuid.nullable());

/** Positive integer kobo. */
export const zPositiveKobo = zKobo.refine((v) => v > 0, "Amount must be greater than zero");

// ── Suppliers ────────────────────────────────────────────────────────────────

export const supplierTypeEnum = z.enum(["farmer", "agent", "cooperative"]);

const supplierFields = {
  type: supplierTypeEnum,
  name: z.string().trim().min(1, "Name is required").max(200),
  phone: zOptPhone,
  village: zOptText(200),
  lga: zOptText(200),
  state: zOptText(100),
  bankName: zOptText(200),
  bankAccountNumber: z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.replace(/\s/g, "")) : emptyToNull(v)),
    z.string().regex(/^\d{10}$/, "Account number must be 10 digits").nullable(),
  ),
  bankAccountName: zOptText(200),
  idNote: zOptText(500),
  photoKey: zOptText(500),
};

export const supplierInput = z.object(supplierFields);
export type SupplierInput = z.output<typeof supplierInput>;

export const supplierUpdateInput = z.object({ id: zUuid, ...supplierFields });
export type SupplierUpdateInput = z.output<typeof supplierUpdateInput>;

export const supplierListInput = z.object({
  q: z.string().trim().max(100).optional(),
  type: supplierTypeEnum.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type SupplierListInput = z.output<typeof supplierListInput>;

export const idInput = z.object({ id: zUuid });
export type IdInput = z.output<typeof idInput>;

// ── Price guides ─────────────────────────────────────────────────────────────

export const priceGuideInput = z.object({
  commodityId: zUuid,
  gradeId: zOptUuid,
  buyingPointId: zOptUuid,
  guideDate: zDateISO,
  maxPricePerKgKobo: zPositiveKobo,
});
export type PriceGuideInput = z.output<typeof priceGuideInput>;

export const priceGuideUpdateInput = z.object({
  id: zUuid,
  guideDate: zDateISO,
  maxPricePerKgKobo: zPositiveKobo,
});
export type PriceGuideUpdateInput = z.output<typeof priceGuideUpdateInput>;

export const priceGuideListInput = z.object({
  commodityId: zUuid.optional(),
  buyingPointId: zUuid.optional(),
  from: zDateISO.optional(),
  to: zDateISO.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type PriceGuideListInput = z.output<typeof priceGuideListInput>;

export const priceGuideLookupInput = z.object({
  commodityId: zUuid,
  gradeId: zOptUuid,
  buyingPointId: zOptUuid,
  date: zDateISO,
});
export type PriceGuideLookupInput = z.output<typeof priceGuideLookupInput>;

// ── Purchases ────────────────────────────────────────────────────────────────

export const deductionReasonEnum = z.enum(["moisture", "foreign_matter", "sack_weight", "other"]);

export const deductionInput = z.object({
  reason: deductionReasonEnum,
  kg: zKgString,
  note: zOptText(300),
});
export type DeductionInputDto = z.output<typeof deductionInput>;

export const purchaseLineInput = z.object({
  /** Client-generated id (offline). Server generates one when absent. */
  id: zUuid.optional(),
  commodityId: zUuid,
  gradeId: zUuid,
  /** When given (and no explicit sack_weight deduction), bags × sack weight is deducted automatically. */
  bagTypeId: zOptUuid,
  bags: z.number().int().min(0).default(0),
  grossKg: zKgString,
  moisturePercent: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, "Moisture % up to 2 decimals")
      .refine((s) => Number(s) <= 100, "Moisture % cannot exceed 100")
      .nullable(),
  ),
  pricePerKgKobo: zKobo,
  deductions: z.array(deductionInput).max(10).default([]),
});
export type PurchaseLineInput = z.output<typeof purchaseLineInput>;

const purchaseBody = {
  supplierId: zUuid,
  buyingPointId: zOptUuid,
  purchaseDate: zDateISO,
  lines: z.array(purchaseLineInput).min(1, "Add at least one line").max(50),
  /** Save without submitting (status draft). */
  saveAsDraft: z.boolean().default(false),
};

export const purchaseCreateInput = z.object({
  /** Client-generated purchase id — offline idempotency key (DECISIONS #11). */
  id: zUuid.optional(),
  ...purchaseBody,
  createdOffline: z.boolean().default(false),
  clientCreatedAt: z.preprocess(emptyToNull, z.iso.datetime({ offset: true }).nullable()).optional(),
});
export type PurchaseCreateInput = z.output<typeof purchaseCreateInput>;

export const purchaseUpdateInput = z.object({ id: zUuid, ...purchaseBody });
export type PurchaseUpdateInput = z.output<typeof purchaseUpdateInput>;

export const purchaseRejectInput = z.object({
  id: zUuid,
  reason: z.string().trim().min(1, "Give a reason").max(500),
});
export type PurchaseRejectInput = z.output<typeof purchaseRejectInput>;

export const purchaseCancelInput = z.object({ id: zUuid, reason: zOptText(500) });
export type PurchaseCancelInput = z.output<typeof purchaseCancelInput>;

export const purchaseStatusEnum = z.enum(["draft", "pending_approval", "approved", "received", "cancelled"]);

export const purchaseListInput = z.object({
  status: purchaseStatusEnum.optional(),
  supplierId: zUuid.optional(),
  buyingPointId: zUuid.optional(),
  from: zDateISO.optional(),
  to: zDateISO.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type PurchaseListInput = z.output<typeof purchaseListInput>;

// ── Receiving ────────────────────────────────────────────────────────────────

export const receivePurchaseInput = z.object({
  purchaseId: zUuid,
  warehouseId: zUuid,
  binId: zOptUuid,
  sendSms: z.boolean().default(false),
});
export type ReceivePurchaseInput = z.output<typeof receivePurchaseInput>;

// ── Advances ─────────────────────────────────────────────────────────────────

export const advanceInput = z.object({
  supplierId: zUuid,
  amountKobo: zPositiveKobo,
  advanceDate: zDateISO,
  note: zOptText(500),
});
export type AdvanceInput = z.output<typeof advanceInput>;

export const advanceListInput = z.object({
  supplierId: zUuid.optional(),
  outstandingOnly: z.boolean().default(false),
  page: zPage,
  pageSize: zPageSize,
});
export type AdvanceListInput = z.output<typeof advanceListInput>;

export const offsetAdvanceInput = z.object({
  advanceId: zUuid,
  /** Cap on the amount to recover; defaults to the advance's whole outstanding. */
  amountKobo: zPositiveKobo.optional(),
});
export type OffsetAdvanceInput = z.output<typeof offsetAdvanceInput>;

// ── Supplier payments ────────────────────────────────────────────────────────

export const paymentMethodEnum = z.enum(["cash", "transfer", "pos"]);

export const supplierPaymentInput = z
  .object({
    supplierId: zUuid,
    amountKobo: zPositiveKobo,
    method: paymentMethodEnum,
    paymentDate: zDateISO,
    reference: zOptText(200),
    note: zOptText(500),
    /** fifo = oldest open received purchase first; manual = explicit picks. */
    mode: z.enum(["fifo", "manual"]).default("fifo"),
    allocations: z
      .array(z.object({ purchaseId: zUuid, amountKobo: zPositiveKobo }))
      .max(100)
      .default([]),
    sendSms: z.boolean().default(false),
  })
  .refine((v) => v.mode === "fifo" || v.allocations.length > 0, {
    message: "Pick at least one purchase to pay",
    path: ["allocations"],
  });
export type SupplierPaymentInput = z.output<typeof supplierPaymentInput>;

export const supplierPaymentListInput = z.object({
  supplierId: zUuid.optional(),
  from: zDateISO.optional(),
  to: zDateISO.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type SupplierPaymentListInput = z.output<typeof supplierPaymentListInput>;

// ── Payables ─────────────────────────────────────────────────────────────────

export const payablesInput = z.object({
  /** Lagos calendar date to age against; defaults to today in Lagos. */
  asOf: zDateISO.optional(),
  supplierId: zUuid.optional(),
});
export type PayablesInput = z.output<typeof payablesInput>;
