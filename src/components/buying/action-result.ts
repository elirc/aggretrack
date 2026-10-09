import { toast } from "sonner";

import type { ActionResult } from "@/lib/authz/guard";

/** Human message for an ActionResult error code from the buying actions. */
export function buyingErrorMessage(code: string): string {
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
    case "DUPLICATE":
      return "That record already exists.";
    case "IN_USE":
      return "It is in use and can't be removed.";
    case "NET_WEIGHT_NEGATIVE":
      return "Deductions are more than the gross weight.";
    case "GRADE_COMMODITY_MISMATCH":
      return "That grade does not belong to the commodity.";
    case "NOT_EDITABLE":
      return "This purchase can no longer be edited.";
    case "INVALID_STATUS":
      return "The purchase is no longer in a state that allows this. Refresh.";
    case "NOT_APPROVED":
      return "Only approved purchases can be received.";
    case "ALREADY_RECEIVED":
      return "This purchase has already been received.";
    case "CANNOT_CANCEL_RECEIVED":
      return "A received purchase cannot be cancelled. Use a stock adjustment.";
    case "ALREADY_CANCELLED":
      return "This purchase is already cancelled.";
    case "WAREHOUSE_INACTIVE":
      return "That warehouse is inactive.";
    case "BIN_WAREHOUSE_MISMATCH":
      return "That bin is not in the selected warehouse.";
    case "NO_LINES":
      return "The purchase has no lines.";
    case "PAYMENT_ALLOCATION_INVALID":
      return "The amounts per purchase don't fit the payment or what is owed.";
    case "ADVANCE_FULLY_RECOVERED":
      return "This advance has nothing left to recover.";
    case "NOTHING_TO_OFFSET":
      return "The supplier has no unpaid received purchases to offset against.";
    case "INVALID_MOVEMENT":
    case "INSUFFICIENT_STOCK":
      return "The stock movement was refused. Check the quantities.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * Run a server action, toast the outcome, and return the ActionResult (never
 * throws — a network failure becomes { ok:false, error:"NETWORK" }).
 */
export async function runBuyingAction<R>(
  call: () => Promise<ActionResult<R>>,
  opts: { success?: string | ((data: R) => string) } = {},
): Promise<ActionResult<R>> {
  let res: ActionResult<R>;
  try {
    res = await call();
  } catch {
    toast.error("Could not reach the server. Check your connection and try again.");
    return { ok: false, error: "NETWORK" };
  }
  if (res.ok) {
    const msg = typeof opts.success === "function" ? opts.success(res.data) : opts.success;
    if (msg) toast.success(msg);
  } else {
    toast.error(buyingErrorMessage(res.error));
  }
  return res;
}
