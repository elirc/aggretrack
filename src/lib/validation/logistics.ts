import { z } from "zod";

import { zDateISO, zKobo, zUuid } from "./common";

/**
 * Logistics, costs and reporting schemas (P2-D).
 * Shared by react-hook-form (zodResolver), server actions and services.
 * Empty optional text / ids become null.
 */

/** Optional free text: "" / undefined → null. */
const zOptText = z
  .string()
  .trim()
  .max(500, "Too long")
  .nullish()
  .transform((v) => (v ? v : null));

/** Optional uuid: "" / undefined → null. */
const zOptUuid = z
  .union([z.literal(""), zUuid])
  .nullish()
  .transform((v) => (v ? v : null));

/** Optional uuid that stays undefined when absent (filters). */
const zFilterUuid = z
  .union([z.literal(""), zUuid])
  .optional()
  .transform((v) => (v ? v : undefined));

export const tripDirectionInput = z.enum(["inbound", "outbound"]);
export type TripDirection = z.output<typeof tripDirectionInput>;

// ── Trips ────────────────────────────────────────────────────────────────────
export const tripInput = z.object({
  direction: tripDirectionInput,
  vehicleId: zOptUuid,
  driverId: zOptUuid,
  origin: zOptText,
  destination: zOptText,
  tripDate: zDateISO,
  costKobo: zKobo.default(0),
  note: zOptText,
});
export type TripInput = z.output<typeof tripInput>;

/** Direction is fixed at creation (links depend on it). */
export const tripUpdateInput = tripInput.omit({ direction: true }).extend({ id: zUuid });
export type TripUpdateInput = z.output<typeof tripUpdateInput>;

export const tripIdInput = z.object({ id: zUuid });
export type TripIdInput = z.output<typeof tripIdInput>;

export const tripLinkPurchasesInput = z.object({
  tripId: zUuid,
  purchaseIds: z.array(zUuid).min(1, "Pick at least one purchase").max(200),
});
export type TripLinkPurchasesInput = z.output<typeof tripLinkPurchasesInput>;

export const tripUnlinkPurchaseInput = z.object({ tripId: zUuid, purchaseId: zUuid });
export type TripUnlinkPurchaseInput = z.output<typeof tripUnlinkPurchaseInput>;

export const tripLinkDispatchesInput = z.object({
  tripId: zUuid,
  dispatchIds: z.array(zUuid).min(1, "Pick at least one dispatch").max(200),
});
export type TripLinkDispatchesInput = z.output<typeof tripLinkDispatchesInput>;

export const tripUnlinkDispatchInput = z.object({ tripId: zUuid, dispatchId: zUuid });
export type TripUnlinkDispatchInput = z.output<typeof tripUnlinkDispatchInput>;

export const tripListInput = z.object({
  from: zDateISO.optional(),
  to: zDateISO.optional(),
  direction: tripDirectionInput.optional(),
  vehicleId: zFilterUuid,
});
export type TripListInput = z.output<typeof tripListInput>;

// ── Expenses ─────────────────────────────────────────────────────────────────
const expenseShape = z.object({
  categoryId: zUuid,
  amountKobo: zKobo.refine((n) => n > 0, "Amount must be more than 0"),
  expenseDate: zDateISO,
  lotId: zOptUuid,
  tripId: zOptUuid,
  warehouseId: zOptUuid,
  note: zOptText,
});

function oneAttachment(v: { lotId: string | null; tripId: string | null; warehouseId: string | null }) {
  return [v.lotId, v.tripId, v.warehouseId].filter((x) => x !== null).length <= 1;
}
const ATTACH_MSG = { message: "Attach to at most one of lot, trip or warehouse", path: ["lotId"] };

export const expenseInput = expenseShape.refine(oneAttachment, ATTACH_MSG);
export type ExpenseInput = z.output<typeof expenseInput>;

export const expenseUpdateInput = expenseShape.extend({ id: zUuid }).refine(oneAttachment, ATTACH_MSG);
export type ExpenseUpdateInput = z.output<typeof expenseUpdateInput>;

export const expenseIdInput = z.object({ id: zUuid });
export type ExpenseIdInput = z.output<typeof expenseIdInput>;

export const expenseListInput = z.object({
  from: zDateISO.optional(),
  to: zDateISO.optional(),
  categoryId: zFilterUuid,
  lotId: zFilterUuid,
  tripId: zFilterUuid,
  warehouseId: zFilterUuid,
});
export type ExpenseListInput = z.output<typeof expenseListInput>;

// ── Reports ──────────────────────────────────────────────────────────────────
const range = { from: zDateISO, to: zDateISO };
const rangeOk = (v: { from: string; to: string }) => v.from <= v.to;
const RANGE_MSG = { message: "'From' must be on or before 'to'", path: ["to"] };

export const purchasesReportInput = z
  .object({
    ...range,
    groupBy: z.enum(["supplier", "commodity", "day", "week", "month"]).default("supplier"),
    supplierId: zFilterUuid,
    commodityId: zFilterUuid,
    buyingPointId: zFilterUuid,
  })
  .refine(rangeOk, RANGE_MSG);
export type PurchasesReportInput = z.output<typeof purchasesReportInput>;

export const stockPositionReportInput = z.object({
  asAt: zDateISO,
  warehouseId: zFilterUuid,
  commodityId: zFilterUuid,
  gradeId: zFilterUuid,
});
export type StockPositionReportInput = z.output<typeof stockPositionReportInput>;

export const stockMovementsReportInput = z
  .object({
    ...range,
    warehouseId: zFilterUuid,
    commodityId: zFilterUuid,
    lotId: zFilterUuid,
    type: z.enum(["receive", "transfer_out", "transfer_in", "adjustment", "dispatch", "return"]).optional(),
    limit: z.coerce.number().int().min(1).max(20_000).default(5_000),
  })
  .refine(rangeOk, RANGE_MSG);
export type StockMovementsReportInput = z.output<typeof stockMovementsReportInput>;

export const salesByCustomerReportInput = z
  .object({ ...range, customerId: zFilterUuid, commodityId: zFilterUuid })
  .refine(rangeOk, RANGE_MSG);
export type SalesByCustomerReportInput = z.output<typeof salesByCustomerReportInput>;

export const marginReportInput = z
  .object({
    ...range,
    by: z.enum(["lot", "sale", "customer", "commodity"]).default("sale"),
    customerId: zFilterUuid,
    commodityId: zFilterUuid,
  })
  .refine(rangeOk, RANGE_MSG);
export type MarginReportInput = z.output<typeof marginReportInput>;

export const payablesAgeingReportInput = z.object({ asAt: zDateISO, supplierId: zFilterUuid });
export type PayablesAgeingReportInput = z.output<typeof payablesAgeingReportInput>;

export const receivablesAgeingReportInput = z.object({ asAt: zDateISO, customerId: zFilterUuid });
export type ReceivablesAgeingReportInput = z.output<typeof receivablesAgeingReportInput>;

export const supplierPerformanceReportInput = z
  .object({ ...range, supplierId: zFilterUuid, commodityId: zFilterUuid })
  .refine(rangeOk, RANGE_MSG);
export type SupplierPerformanceReportInput = z.output<typeof supplierPerformanceReportInput>;

export const shrinkageReportInput = z
  .object({ ...range, warehouseId: zFilterUuid, commodityId: zFilterUuid })
  .refine(rangeOk, RANGE_MSG);
export type ShrinkageReportInput = z.output<typeof shrinkageReportInput>;

export const tripCostsReportInput = z
  .object({ ...range, direction: tripDirectionInput.optional(), vehicleId: zFilterUuid })
  .refine(rangeOk, RANGE_MSG);
export type TripCostsReportInput = z.output<typeof tripCostsReportInput>;

export const REPORT_KEYS = [
  "purchases",
  "stock-position",
  "stock-movements",
  "sales-by-customer",
  "margin",
  "payables-ageing",
  "receivables-ageing",
  "supplier-performance",
  "shrinkage",
  "trip-costs",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** One envelope for the generic report runner (page + export route). */
export const runReportInput = z.discriminatedUnion("report", [
  z.object({ report: z.literal("purchases"), params: purchasesReportInput }),
  z.object({ report: z.literal("stock-position"), params: stockPositionReportInput }),
  z.object({ report: z.literal("stock-movements"), params: stockMovementsReportInput }),
  z.object({ report: z.literal("sales-by-customer"), params: salesByCustomerReportInput }),
  z.object({ report: z.literal("margin"), params: marginReportInput }),
  z.object({ report: z.literal("payables-ageing"), params: payablesAgeingReportInput }),
  z.object({ report: z.literal("receivables-ageing"), params: receivablesAgeingReportInput }),
  z.object({ report: z.literal("supplier-performance"), params: supplierPerformanceReportInput }),
  z.object({ report: z.literal("shrinkage"), params: shrinkageReportInput }),
  z.object({ report: z.literal("trip-costs"), params: tripCostsReportInput }),
]);
export type RunReportInput = z.output<typeof runReportInput>;

export const lotTraceInput = z.object({ lotId: zUuid });
export const saleTraceInput = z.object({ salesOrderId: zUuid });
export const dashboardInput = z.object({}).default({});
