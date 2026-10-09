"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/customerPayments";
import { customerPaymentInput, customerPaymentListInput, idInput } from "@/lib/validation/selling";

/** Customer payment server actions (P2-C). Payments are recorded, not processed. */

export const recordCustomerPaymentAction = orgAction({
  permission: "customer-payment.write",
  schema: customerPaymentInput,
  handler: async (input, ctx) => {
    const res = await svc.recordCustomerPayment(db, ctx, input);
    revalidatePath("/customer-payments");
    revalidatePath("/invoices");
    revalidatePath("/receivables");
    revalidatePath(`/customers/${input.customerId}`);
    return { id: res.payment.id, paymentNumber: res.payment.paymentNumber, unallocatedKobo: res.unallocatedKobo };
  },
});

export const listCustomerPaymentsAction = orgAction({
  permission: "customer-payment.read",
  schema: customerPaymentListInput,
  handler: (input, ctx) => svc.listCustomerPayments(db, ctx, input),
});

export const getCustomerPaymentAction = orgAction({
  permission: "customer-payment.read",
  schema: idInput,
  handler: (input, ctx) => svc.getCustomerPayment(db, ctx, input),
});
