"use server";

import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/statements";
import { zDateISO, zUuid } from "@/lib/validation/common";

/**
 * Printable statements (P4-D). Permission: report.export for both sides —
 * owners, managers and accountants. A statement exposes the full money
 * history of a counterparty, so supplier.read / customer.read (procurement /
 * sales officers) is deliberately not enough. report.export is non-mutating,
 * so read-only organisations can still print statements.
 */

const statementInput = z
  .object({ id: zUuid, from: zDateISO, to: zDateISO })
  .refine((v) => v.from <= v.to, { message: "Start date must be on or before the end date", path: ["from"] });

export const generateSupplierStatementAction = orgAction({
  permission: "report.export",
  schema: statementInput,
  handler: async (input, ctx) =>
    svc.generateSupplierStatement(db, ctx, input.id, { from: input.from, to: input.to }),
});

export const generateCustomerStatementAction = orgAction({
  permission: "report.export",
  schema: statementInput,
  handler: async (input, ctx) =>
    svc.generateCustomerStatement(db, ctx, input.id, { from: input.from, to: input.to }),
});
