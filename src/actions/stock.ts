"use server";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as q from "@/lib/services/stockQueries";
import {
  inTransitQuery,
  lotDetailQuery,
  movementHistoryQuery,
  stockAgeingQuery,
  stockPositionQuery,
} from "@/lib/validation/warehouse";

/**
 * Stock read actions (P2-B). Server components may call the services
 * directly with a resolved OrgContext; these wrappers exist for client-side
 * filter refreshes. Restrictions (warehouses, hidden prices) are applied in
 * the services from the server-resolved context.
 */

const R = "stock.read" as const;

export const getStockPositionAction = orgAction({
  permission: R,
  schema: stockPositionQuery,
  handler: (input, ctx) => q.getStockPosition(db, ctx, input),
});

export const getLotDetailAction = orgAction({
  permission: R,
  schema: lotDetailQuery,
  handler: (input, ctx) => q.getLotDetail(db, ctx, input),
});

export const getStockAgeingAction = orgAction({
  permission: R,
  schema: stockAgeingQuery,
  handler: (input, ctx) => q.getStockAgeing(db, ctx, input),
});

export const getMovementHistoryAction = orgAction({
  permission: R,
  schema: movementHistoryQuery,
  handler: (input, ctx) => q.getMovementHistory(db, ctx, input),
});

export const getInTransitAction = orgAction({
  permission: R,
  schema: inTransitQuery,
  handler: (input, ctx) => q.getInTransit(db, ctx, input),
});
