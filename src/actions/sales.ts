"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as alloc from "@/lib/services/allocation";
import * as so from "@/lib/services/salesOrders";
import {
  autoAllocateOrderInput,
  availableLotsInput,
  idInput,
  releaseAllocationInput,
  reserveInput,
  salesOrderInput,
  salesOrderListInput,
  salesOrderUpdateInput,
} from "@/lib/validation/selling";

/** Sales order + allocation server actions (P2-C). */

function refresh(orderId?: string) {
  revalidatePath("/sales");
  if (orderId) revalidatePath(`/sales/${orderId}`);
}

export const createSalesOrderAction = orgAction({
  permission: "sale.write",
  schema: salesOrderInput,
  handler: async (input, ctx) => {
    const order = await so.createSalesOrder(db, ctx, input);
    refresh(order.id);
    return { id: order.id, orderNumber: order.orderNumber };
  },
});

export const updateSalesOrderAction = orgAction({
  permission: "sale.write",
  schema: salesOrderUpdateInput,
  handler: async (input, ctx) => {
    const order = await so.updateSalesOrder(db, ctx, input);
    refresh(order.id);
    return { id: order.id };
  },
});

export const confirmSalesOrderAction = orgAction({
  permission: "sale.write",
  schema: idInput,
  handler: async (input, ctx) => {
    const order = await so.confirmSalesOrder(db, ctx, input);
    refresh(order.id);
    return { id: order.id, status: order.status };
  },
});

export const cancelSalesOrderAction = orgAction({
  permission: "sale.write",
  schema: idInput,
  handler: async (input, ctx) => {
    const order = await so.cancelSalesOrder(db, ctx, input);
    refresh(order.id);
    return { id: order.id, status: order.status };
  },
});

export const listSalesOrdersAction = orgAction({
  permission: "sale.read",
  schema: salesOrderListInput,
  handler: (input, ctx) => so.listSalesOrders(db, ctx, input),
});

export const getSalesOrderAction = orgAction({
  permission: "sale.read",
  schema: idInput,
  handler: (input, ctx) => so.getSalesOrder(db, ctx, input),
});

export const reserveForSalesLineAction = orgAction({
  permission: "sale.allocate",
  schema: reserveInput,
  handler: async (input, ctx) => {
    const rows = await alloc.reserveForSalesLine(db, ctx, input);
    refresh();
    return { allocationIds: rows.map((r) => r.id) };
  },
});

export const autoAllocateOrderAction = orgAction({
  permission: "sale.allocate",
  schema: autoAllocateOrderInput,
  handler: async (input, ctx) => {
    const rows = await alloc.autoAllocateOrder(db, ctx, input);
    refresh(input.salesOrderId);
    return { allocationIds: rows.map((r) => r.id) };
  },
});

export const releaseAllocationAction = orgAction({
  permission: "sale.allocate",
  schema: releaseAllocationInput,
  handler: async (input, ctx) => {
    const rows = await alloc.releaseAllocation(db, ctx, input);
    refresh();
    return { releasedIds: rows.map((r) => r.id) };
  },
});

export const listAvailableLotsAction = orgAction({
  permission: "stock.read",
  schema: availableLotsInput,
  handler: (input, ctx) => alloc.listAvailableLots(db, ctx, input),
});
