"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/billing";
import { cancelSubscriptionInput, startCheckoutInput } from "@/lib/validation/billing";

// billing.manage is exempt from orgAction's read-only gate (see guard.ts):
// checkout must work for exactly the orgs that are read-only.

const _startCheckout = orgAction({
  permission: "billing.manage",
  schema: startCheckoutInput,
  handler: (input, ctx) => svc.startCheckout(db, ctx, input),
});

export async function startCheckoutAction(raw: z.input<typeof startCheckoutInput>) {
  return _startCheckout(raw);
}

const _cancel = orgAction({
  permission: "billing.manage",
  schema: cancelSubscriptionInput,
  handler: async (_input, ctx) => {
    const res = await svc.cancelSubscription(db, ctx);
    revalidatePath("/settings/billing");
    return res;
  },
});

export async function cancelSubscriptionAction(raw: z.input<typeof cancelSubscriptionInput>) {
  return _cancel(raw);
}
