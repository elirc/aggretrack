"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/customers";
import { customerInput, customerListInput, customerUpdateInput, idInput } from "@/lib/validation/selling";

/** Customer server actions (P2-C). Organisation always comes from the session. */

export const createCustomerAction = orgAction({
  permission: "customer.write",
  schema: customerInput,
  handler: async (input, ctx) => {
    const row = await svc.createCustomer(db, ctx, input);
    revalidatePath("/customers");
    return { id: row.id };
  },
});

export const updateCustomerAction = orgAction({
  permission: "customer.write",
  schema: customerUpdateInput,
  handler: async (input, ctx) => {
    const row = await svc.updateCustomer(db, ctx, input);
    revalidatePath("/customers");
    revalidatePath(`/customers/${row.id}`);
    return { id: row.id };
  },
});

export const listCustomersAction = orgAction({
  permission: "customer.read",
  schema: customerListInput,
  handler: (input, ctx) => svc.listCustomers(db, ctx, input),
});

export const getCustomerDetailAction = orgAction({
  permission: "customer.read",
  schema: idInput,
  handler: (input, ctx) => svc.getCustomerDetail(db, ctx, input),
});
