"use server";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import { getDashboard } from "@/lib/services/dashboard";
import { lotMargin, saleMargin } from "@/lib/services/margin";
import { runReport } from "@/lib/services/reports";
import { lotTrace, saleTrace } from "@/lib/services/traceability";
import { dashboardInput, lotTraceInput, runReportInput, saleTraceInput } from "@/lib/validation/logistics";

/**
 * Reports, traceability and dashboard read actions (P2-D).
 * Exports (Excel/PDF) live in the wave-4 export route and gate on report.export.
 */

export const runReportAction = orgAction({
  permission: "report.read",
  schema: runReportInput,
  handler: (input, ctx) => runReport(db, ctx, input),
});

export const lotTraceAction = orgAction({
  permission: "report.read",
  schema: lotTraceInput,
  handler: async (input, ctx) => ({
    trace: await lotTrace(db, ctx, input.lotId),
    margin: ctx.restrictions.hidePrices ? null : await lotMargin(db, ctx, input.lotId),
  }),
});

export const saleTraceAction = orgAction({
  permission: "report.read",
  schema: saleTraceInput,
  handler: async (input, ctx) => ({
    trace: await saleTrace(db, ctx, input.salesOrderId),
    margin: ctx.restrictions.hidePrices ? null : await saleMargin(db, ctx, input.salesOrderId),
  }),
});

export const getDashboardAction = orgAction({
  permission: "dashboard.read",
  schema: dashboardInput,
  handler: (_input, ctx) => getDashboard(db, ctx),
});
