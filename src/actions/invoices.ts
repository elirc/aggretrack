"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/invoices";
import * as recv from "@/lib/services/receivables";
import { idInput, invoiceFromDispatchInput, invoiceListInput, receivablesInput } from "@/lib/validation/selling";

/** Invoice + receivables server actions (P2-C). */

export const createInvoiceFromDispatchAction = orgAction({
  permission: "invoice.write",
  schema: invoiceFromDispatchInput,
  handler: async (input, ctx) => {
    const row = await svc.createInvoiceFromDispatch(db, ctx, input);
    revalidatePath("/invoices");
    revalidatePath("/receivables");
    return { id: row.id, invoiceNumber: row.invoiceNumber };
  },
});

export const voidInvoiceAction = orgAction({
  permission: "invoice.write",
  schema: idInput,
  handler: async (input, ctx) => {
    const row = await svc.voidInvoice(db, ctx, input);
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${row.id}`);
    revalidatePath("/receivables");
    return { id: row.id, status: row.status };
  },
});

export const listInvoicesAction = orgAction({
  permission: "invoice.read",
  schema: invoiceListInput,
  handler: (input, ctx) => svc.listInvoices(db, ctx, input),
});

export const getInvoiceAction = orgAction({
  permission: "invoice.read",
  schema: idInput,
  handler: (input, ctx) => svc.getInvoice(db, ctx, input),
});

export const receivablesAgeingAction = orgAction({
  permission: "invoice.read",
  schema: receivablesInput,
  handler: (input, ctx) => recv.receivablesAgeing(db, ctx, input),
});
