import { z } from "zod";

import { kgToGrams } from "@/lib/domain/units";
import { zDateISO, zKgString, zKobo, zPage, zPageSize, zUuid } from "./common";

/**
 * Selling module schemas (P2-C). Shared by forms, server actions and the sync
 * endpoint. Weights travel as kg strings; services convert to grams.
 */

const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const zPositiveKg = zKgString.refine((s) => kgToGrams(s) > 0, "Weight must be greater than 0");

// ── Customers ───────────────────────────────────────────────────────────────

export const customerInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  phone: optText(40),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email"),
  address: optText(500),
  state: optText(100),
  note: optText(1000),
});
export type CustomerInput = z.output<typeof customerInput>;

export const customerUpdateInput = customerInput.extend({ id: zUuid });
export type CustomerUpdateInput = z.output<typeof customerUpdateInput>;

export const customerListInput = z.object({
  search: z.string().trim().max(200).optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type CustomerListInput = z.output<typeof customerListInput>;

export const idInput = z.object({ id: zUuid });
export type IdInput = z.output<typeof idInput>;

// ── Sales orders ────────────────────────────────────────────────────────────

export const salesLineInput = z.object({
  commodityId: zUuid,
  gradeId: zUuid,
  kg: zPositiveKg,
  pricePerKgKobo: zKobo,
});
export type SalesLineInput = z.output<typeof salesLineInput>;

export const salesOrderInput = z.object({
  customerId: zUuid,
  orderDate: zDateISO,
  lines: z.array(salesLineInput).min(1, "Add at least one line").max(100),
});
export type SalesOrderInput = z.output<typeof salesOrderInput>;

export const salesOrderUpdateInput = salesOrderInput.extend({ id: zUuid });
export type SalesOrderUpdateInput = z.output<typeof salesOrderUpdateInput>;

export const salesOrderStatusValues = [
  "draft",
  "confirmed",
  "allocated",
  "dispatched",
  "completed",
  "cancelled",
] as const;

export const salesOrderListInput = z.object({
  status: z.enum(salesOrderStatusValues).optional(),
  customerId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type SalesOrderListInput = z.output<typeof salesOrderListInput>;

// ── Allocation ──────────────────────────────────────────────────────────────

/** A manual pick, entered in kg; transformed to grams (domain AllocationLine). */
export const allocationPickInput = z
  .object({ lotId: zUuid, warehouseId: zUuid, kg: zPositiveKg })
  .transform((p) => ({ lotId: p.lotId, warehouseId: p.warehouseId, grams: kgToGrams(p.kg) }));

export const reserveInput = z
  .object({
    salesLineId: zUuid,
    mode: z.enum(["fifo", "manual"]),
    picks: z.array(allocationPickInput).max(200).optional(),
    warehouseId: zUuid.optional(),
  })
  .refine((v) => v.mode !== "manual" || (v.picks && v.picks.length > 0), {
    message: "Pick at least one lot",
    path: ["picks"],
  });
export type ReserveInput = z.output<typeof reserveInput>;

export const autoAllocateOrderInput = z.object({
  salesOrderId: zUuid,
  warehouseId: zUuid.optional(),
});
export type AutoAllocateOrderInput = z.output<typeof autoAllocateOrderInput>;

export const releaseAllocationInput = z
  .object({ allocationId: zUuid.optional(), salesLineId: zUuid.optional() })
  .refine((v) => Boolean(v.allocationId) !== Boolean(v.salesLineId), {
    message: "Give exactly one of allocationId or salesLineId",
  });
export type ReleaseAllocationInput = z.output<typeof releaseAllocationInput>;

export const availableLotsInput = z.object({
  commodityId: zUuid,
  gradeId: zUuid,
  warehouseId: zUuid.optional(),
});
export type AvailableLotsInput = z.output<typeof availableLotsInput>;

// ── Dispatches ──────────────────────────────────────────────────────────────

export const dispatchInput = z.object({
  /** Client-generated UUID (offline-capable); becomes the dispatch PK. */
  clientId: zUuid.optional(),
  salesOrderId: zUuid,
  allocationIds: z.array(zUuid).min(1, "Select at least one allocation").max(200),
  vehicleId: zUuid.optional().nullable(),
  driverId: zUuid.optional().nullable(),
});
export type DispatchInput = z.output<typeof dispatchInput>;

export const deliveryInput = z.object({
  dispatchId: zUuid,
  deliveredKg: zKgString,
});
export type DeliveryInput = z.output<typeof deliveryInput>;

export const dispatchListInput = z.object({
  status: z.enum(["in_transit", "delivered"]).optional(),
  salesOrderId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type DispatchListInput = z.output<typeof dispatchListInput>;

// ── Invoices ────────────────────────────────────────────────────────────────

export const invoiceFromDispatchInput = z.object({
  dispatchId: zUuid,
  invoiceDate: zDateISO.optional(),
  dueDate: zDateISO.optional().nullable(),
  /** Tax line is off by default; on → organisation_settings.invoice_tax_percent. */
  applyTax: z.boolean().optional().default(false),
});
export type InvoiceFromDispatchInput = z.output<typeof invoiceFromDispatchInput>;

export const invoiceListInput = z.object({
  status: z.enum(["issued", "part_paid", "paid", "void"]).optional(),
  customerId: zUuid.optional(),
  openOnly: z.boolean().optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type InvoiceListInput = z.output<typeof invoiceListInput>;

// ── Customer payments ───────────────────────────────────────────────────────

export const customerPaymentInput = z.object({
  customerId: zUuid,
  amountKobo: zKobo.refine((v) => v > 0, "Amount must be greater than 0"),
  method: z.enum(["cash", "transfer", "pos"]),
  paymentDate: zDateISO,
  reference: optText(200),
  note: optText(1000),
  /** Manual override; omitted → FIFO over open invoices, oldest invoice_date first. */
  allocations: z
    .array(
      z.object({
        invoiceId: zUuid,
        amountKobo: zKobo.refine((v) => v > 0, "Amount must be greater than 0"),
      }),
    )
    .max(200)
    .optional(),
});
export type CustomerPaymentInput = z.output<typeof customerPaymentInput>;

export const customerPaymentListInput = z.object({
  customerId: zUuid.optional(),
  page: zPage,
  pageSize: zPageSize,
});
export type CustomerPaymentListInput = z.output<typeof customerPaymentListInput>;

// ── Receivables ─────────────────────────────────────────────────────────────

export const receivablesInput = z.object({
  asOf: zDateISO.optional(),
  customerId: zUuid.optional(),
});
export type ReceivablesInput = z.output<typeof receivablesInput>;
