"use client";

import { toast } from "sonner";

import type { ActionResult } from "@/lib/authz/guard";

/** Human message for an orgAction error code (DomainError codes from the selling services). */
export function sellingErrorMessage(code: string): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "READ_ONLY":
      return "Subscription inactive — your organisation is read only.";
    case "VALIDATION":
      return "Please check the highlighted fields.";
    case "NOT_FOUND":
      return "That record no longer exists. Refresh and try again.";
    case "CONFLICT":
      return "That record changed. Refresh and try again.";
    case "INSUFFICIENT_STOCK":
      return "Not enough available stock to cover this.";
    case "ALLOCATION_INVALID":
      return "Those lot picks are not valid. Check the kg against what is available.";
    case "LINE_FULLY_ALLOCATED":
      return "This line is already fully allocated.";
    case "ORDER_NOT_ALLOCATABLE":
      return "Confirm the order before allocating stock.";
    case "ORDER_NOT_DRAFT":
      return "Only draft orders can be confirmed or edited.";
    case "ORDER_NOT_CANCELLABLE":
      return "Part of this order has been dispatched; it can't be cancelled.";
    case "ORDER_ALREADY_CANCELLED":
      return "This order is already cancelled.";
    case "ORDER_NOT_DISPATCHABLE":
      return "This order can't be dispatched in its current state.";
    case "ALLOCATION_NOT_RESERVED":
      return "One of the selected allocations is no longer reserved. Refresh and try again.";
    case "ALLOCATION_NOT_IN_ORDER":
      return "One of the selected allocations belongs to another order.";
    case "FORBIDDEN_WAREHOUSE":
      return "You don't have access to that warehouse.";
    case "DISPATCH_ALREADY_DELIVERED":
      return "Delivery has already been recorded for this dispatch.";
    case "DELIVERED_EXCEEDS_DISPATCHED":
      return "Delivered weight can't exceed the dispatched weight.";
    case "ALREADY_INVOICED":
      return "This dispatch already has an invoice.";
    case "INVOICE_ALREADY_VOID":
      return "This invoice is already void.";
    case "INVOICE_HAS_PAYMENTS":
      return "Invoices with payments allocated can't be voided.";
    case "PAYMENT_ALLOCATION_INVALID":
      return "The allocation doesn't match the open invoices or exceeds the payment.";
    case "DUPLICATE":
      return "That record already exists.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Call an orgAction, toast on failure (and optional success), return the result. */
export async function callAction<I, R>(
  action: (raw: I) => Promise<ActionResult<R>>,
  input: I,
  success?: string,
): Promise<ActionResult<R>> {
  let res: ActionResult<R>;
  try {
    res = await action(input);
  } catch {
    res = { ok: false, error: "INTERNAL" };
  }
  if (res.ok) {
    if (success) toast.success(success);
  } else {
    toast.error(sellingErrorMessage(res.error));
  }
  return res;
}
