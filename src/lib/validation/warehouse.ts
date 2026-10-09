import { z } from "zod";

import { zDateISO, zKgString, zPage, zPageSize, zUuid } from "./common";

/**
 * Warehouse module schemas (P2-B): transfers, counts, adjustments and the
 * stock query filters. Weights travel as kg decimal strings (converted to
 * integer grams inside services). Shared by forms, server actions and services.
 */

const zPositiveKg = zKgString.refine((s) => Number(s) > 0, "Must be more than 0 kg");

/** Signed, non-zero kg string ("-12.500", "3"). */
export const zSignedKgString = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, "Enter a weight in kg (up to 3 decimals)")
  .refine((s) => Number(s) !== 0, "Must not be 0 kg");

const zBags = z.coerce.number().int("Whole bags only").min(0, "Must be 0 or more");
const zSignedBags = z.coerce.number().int("Whole bags only");

const zOptUuid = z
  .union([z.literal(""), zUuid])
  .nullish()
  .transform((v) => (v ? v : null));

const zOptText = z
  .string()
  .trim()
  .max(500, "Too long")
  .nullish()
  .transform((v) => (v ? v : null));

// ── Transfers ──

export const transferLineInput = z.object({
  lotId: zUuid,
  kg: zPositiveKg,
  bags: zBags.default(0),
});

export const createTransferInput = z
  .object({
    fromWarehouseId: zUuid,
    toWarehouseId: zUuid,
    lines: z.array(transferLineInput).min(1, "Add at least one line"),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: "Source and destination must differ",
    path: ["toWarehouseId"],
  });
export type CreateTransferInput = z.output<typeof createTransferInput>;

export const transferIdInput = z.object({ transferId: zUuid });
export type TransferIdInput = z.output<typeof transferIdInput>;

export const receiveTransferInput = z.object({
  transferId: zUuid,
  lines: z
    .array(
      z.object({
        lineId: zUuid,
        receivedKg: zKgString,
        receivedBags: zBags.optional(),
        binId: zOptUuid,
      }),
    )
    .min(1, "Enter received weights"),
});
export type ReceiveTransferInput = z.output<typeof receiveTransferInput>;

export const listTransfersInput = z.object({
  status: z.enum(["draft", "in_transit", "received", "cancelled"]).optional(),
  warehouseId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type ListTransfersInput = z.output<typeof listTransfersInput>;

// ── Counts ──

export const countLineInput = z.object({
  lotId: zUuid,
  binId: zOptUuid,
  countedKg: zKgString,
  countedBags: zBags.nullish().transform((v) => (v === undefined ? null : v)),
});

export const createCountInput = z.object({
  warehouseId: zUuid,
  countedAt: z.coerce.date().optional(),
  lines: z.array(countLineInput).min(1, "Add at least one line"),
});
export type CreateCountInput = z.output<typeof createCountInput>;

export const countIdInput = z.object({ countId: zUuid });
export type CountIdInput = z.output<typeof countIdInput>;

export const listCountsInput = z.object({
  status: z.enum(["draft", "posted", "cancelled"]).optional(),
  warehouseId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type ListCountsInput = z.output<typeof listCountsInput>;

// ── Adjustments ──

export const MANUAL_ADJUSTMENT_REASONS = ["shrinkage", "spoilage", "theft", "re_bagging"] as const;
export type ManualAdjustmentReason = (typeof MANUAL_ADJUSTMENT_REASONS)[number];

export const createAdjustmentInput = z.object({
  lotId: zUuid,
  warehouseId: zUuid,
  binId: zOptUuid,
  reason: z.enum(MANUAL_ADJUSTMENT_REASONS),
  /** Signed: negative removes stock, positive adds (e.g. re-bagging gain). */
  kg: zSignedKgString,
  bags: zSignedBags.default(0),
  note: zOptText,
});
export type CreateAdjustmentInput = z.output<typeof createAdjustmentInput>;

export const adjustmentIdInput = z.object({ adjustmentId: zUuid });
export type AdjustmentIdInput = z.output<typeof adjustmentIdInput>;

export const rejectAdjustmentInput = z.object({
  adjustmentId: zUuid,
  reason: z.string().trim().min(1, "Give a reason").max(500, "Too long"),
});
export type RejectAdjustmentInput = z.output<typeof rejectAdjustmentInput>;

export const listAdjustmentsInput = z.object({
  status: z.enum(["pending_approval", "posted", "rejected"]).optional(),
  warehouseId: zUuid.optional(),
  lotId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type ListAdjustmentsInput = z.output<typeof listAdjustmentsInput>;

// ── Stock queries ──

export const stockPositionQuery = z.object({
  commodityId: zUuid.optional(),
  gradeId: zUuid.optional(),
  warehouseId: zUuid.optional(),
});
export type StockPositionQuery = z.output<typeof stockPositionQuery>;

export const lotDetailQuery = z.object({ lotId: zUuid });
export type LotDetailQuery = z.output<typeof lotDetailQuery>;

export const stockAgeingQuery = z.object({
  commodityId: zUuid.optional(),
  warehouseId: zUuid.optional(),
  asOf: z.coerce.date().optional(),
});
export type StockAgeingQuery = z.output<typeof stockAgeingQuery>;

export const MOVEMENT_TYPES = [
  "receive",
  "transfer_out",
  "transfer_in",
  "adjustment",
  "dispatch",
  "return",
] as const;

export const movementHistoryQuery = z
  .object({
    lotId: zUuid.optional(),
    warehouseId: zUuid.optional(),
    type: z.enum(MOVEMENT_TYPES).optional(),
    /** Inclusive Lagos calendar dates. */
    fromDate: zDateISO.optional(),
    toDate: zDateISO.optional(),
    page: zPage,
    pageSize: zPageSize,
  })
  .refine((v) => !v.fromDate || !v.toDate || v.fromDate <= v.toDate, {
    message: "From date must be on or before to date",
    path: ["toDate"],
  });
export type MovementHistoryQuery = z.output<typeof movementHistoryQuery>;

export const inTransitQuery = z.object({ warehouseId: zUuid.optional() });
export type InTransitQuery = z.output<typeof inTransitQuery>;
