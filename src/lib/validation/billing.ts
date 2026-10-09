import { z } from "zod";

import { zUuid } from "./common";

/** Billing schemas (P4-C). */

export const startCheckoutInput = z.object({ planId: zUuid });
export type StartCheckoutInput = z.output<typeof startCheckoutInput>;

export const cancelSubscriptionInput = z.object({
  /** Typed confirmation guard from the UI ("CANCEL"). */
  confirm: z.literal(true, "Confirm the cancellation"),
});
export type CancelSubscriptionInput = z.output<typeof cancelSubscriptionInput>;

export const mockCheckoutQuery = z.object({
  ref: z.string().trim().min(1).max(200),
  plan: z.string().trim().min(1).max(200),
});
