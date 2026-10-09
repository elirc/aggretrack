"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as payables from "@/lib/services/payables";
import { enqueuePendingJobs } from "@/lib/services/suppliers";
import * as svc from "@/lib/services/supplierPayments";
import {
  idInput,
  offsetAdvanceInput,
  payablesInput,
  supplierPaymentInput,
  supplierPaymentListInput,
} from "@/lib/validation/buying";

/** Supplier payment, advance offset and payables server actions (P2-A). */

function refresh(supplierId?: string) {
  revalidatePath("/supplier-payments");
  revalidatePath("/payables");
  revalidatePath("/advances");
  if (supplierId) revalidatePath(`/suppliers/${supplierId}`);
}

export const recordSupplierPaymentAction = orgAction({
  permission: "supplier-payment.write",
  schema: supplierPaymentInput,
  handler: async (input, ctx) => {
    const res = await svc.recordSupplierPayment(db, ctx, input);
    await enqueuePendingJobs(res.jobs);
    refresh(input.supplierId);
    return {
      id: res.payment.id,
      paymentNumber: res.payment.paymentNumber,
      allocations: res.allocations,
      unallocatedKobo: res.unallocatedKobo,
    };
  },
});

export const offsetAdvanceAction = orgAction({
  permission: "supplier-payment.write",
  schema: offsetAdvanceInput,
  handler: async (input, ctx) => {
    const res = await svc.offsetAdvance(db, ctx, input);
    refresh();
    return res;
  },
});

export const listSupplierPaymentsAction = orgAction({
  permission: "supplier-payment.read",
  schema: supplierPaymentListInput,
  handler: async (input, ctx) => svc.listSupplierPayments(db, ctx, input),
});

export const getSupplierPaymentAction = orgAction({
  permission: "supplier-payment.read",
  schema: idInput,
  handler: async (input, ctx) => svc.getSupplierPayment(db, ctx, input.id),
});

export const payablesAgeingAction = orgAction({
  permission: "supplier-payment.read",
  schema: payablesInput,
  handler: async (input, ctx) => payables.payablesAgeing(db, ctx, input),
});

export const listPayablesAction = orgAction({
  permission: "supplier-payment.read",
  schema: payablesInput,
  handler: async (input, ctx) => payables.listPayables(db, ctx, input),
});
