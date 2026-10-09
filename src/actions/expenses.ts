"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as expenses from "@/lib/services/expenses";
import {
  expenseIdInput,
  expenseInput,
  expenseListInput,
  expenseUpdateInput,
} from "@/lib/validation/logistics";

/** Expense server actions (P2-D). Landed-cost recompute happens inside the service tx. */

function refresh() {
  revalidatePath("/expenses");
  revalidatePath("/trips");
  revalidatePath("/stock");
}

export const listExpensesAction = orgAction({
  permission: "expense.read",
  schema: expenseListInput,
  handler: (input, ctx) => expenses.listExpenses(db, ctx, input),
});

export const createExpenseAction = orgAction({
  permission: "expense.write",
  schema: expenseInput,
  handler: async (input, ctx) => {
    const row = await expenses.createExpense(db, ctx, input);
    refresh();
    return { id: row.id, expenseNumber: row.expenseNumber };
  },
});

export const updateExpenseAction = orgAction({
  permission: "expense.write",
  schema: expenseUpdateInput,
  handler: async (input, ctx) => {
    const row = await expenses.updateExpense(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});

export const deleteExpenseAction = orgAction({
  permission: "expense.write",
  schema: expenseIdInput,
  handler: async (input, ctx) => {
    const res = await expenses.deleteExpense(db, ctx, input.id);
    refresh();
    return res;
  },
});
