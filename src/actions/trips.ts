"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as trips from "@/lib/services/trips";
import {
  tripIdInput,
  tripInput,
  tripLinkDispatchesInput,
  tripLinkPurchasesInput,
  tripListInput,
  tripUnlinkDispatchInput,
  tripUnlinkPurchaseInput,
  tripUpdateInput,
} from "@/lib/validation/logistics";

/**
 * Trip server actions (P2-D). Thin orgAction wrappers: session-resolved org,
 * permission, read-only gate, zod parse → service (which owns the tx,
 * audit and landed-cost recompute).
 */

function refresh(tripId?: string) {
  revalidatePath("/trips");
  if (tripId) revalidatePath(`/trips/${tripId}`);
  revalidatePath("/stock");
}

export const listTripsAction = orgAction({
  permission: "trip.read",
  schema: tripListInput,
  handler: (input, ctx) => trips.listTrips(db, ctx, input),
});

export const getTripAction = orgAction({
  permission: "trip.read",
  schema: tripIdInput,
  handler: (input, ctx) => trips.getTrip(db, ctx, input.id),
});

export const createTripAction = orgAction({
  permission: "trip.write",
  schema: tripInput,
  handler: async (input, ctx) => {
    const row = await trips.createTrip(db, ctx, input);
    refresh(row.id);
    return { id: row.id, tripNumber: row.tripNumber };
  },
});

export const updateTripAction = orgAction({
  permission: "trip.write",
  schema: tripUpdateInput,
  handler: async (input, ctx) => {
    const row = await trips.updateTrip(db, ctx, input);
    refresh(row.id);
    return { id: row.id };
  },
});

export const deleteTripAction = orgAction({
  permission: "trip.write",
  schema: tripIdInput,
  handler: async (input, ctx) => {
    const res = await trips.deleteTrip(db, ctx, input.id);
    refresh();
    return res;
  },
});

export const linkTripPurchasesAction = orgAction({
  permission: "trip.write",
  schema: tripLinkPurchasesInput,
  handler: async (input, ctx) => {
    const res = await trips.linkPurchases(db, ctx, input);
    refresh(input.tripId);
    return res;
  },
});

export const unlinkTripPurchaseAction = orgAction({
  permission: "trip.write",
  schema: tripUnlinkPurchaseInput,
  handler: async (input, ctx) => {
    const res = await trips.unlinkPurchase(db, ctx, input);
    refresh(input.tripId);
    return res;
  },
});

export const linkTripDispatchesAction = orgAction({
  permission: "trip.write",
  schema: tripLinkDispatchesInput,
  handler: async (input, ctx) => {
    const res = await trips.linkDispatches(db, ctx, input);
    refresh(input.tripId);
    return res;
  },
});

export const unlinkTripDispatchAction = orgAction({
  permission: "trip.write",
  schema: tripUnlinkDispatchInput,
  handler: async (input, ctx) => {
    const res = await trips.unlinkDispatch(db, ctx, input);
    refresh(input.tripId);
    return res;
  },
});
