import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/auth";
import { db } from "@/db/client";
import {
  member,
  memberBuyingPointAccess,
  memberWarehouseAccess,
  organisationSettings,
  subscriptions,
} from "@/db/schema";
import type { OrgContext, Role } from "./context";
import { ALL_ROLES } from "./permissions";

function isReadOnly(sub: {
  status: string;
  trialEndsAt: Date | null;
} | null): boolean {
  // No subscription row yet (org mid-creation): don't brick the org; the
  // billing wave guarantees a row per org.
  if (!sub) return false;
  if (sub.status === "past_due" || sub.status === "cancelled") return true;
  if (sub.status === "trialing") {
    return sub.trialEndsAt !== null && sub.trialEndsAt.getTime() < Date.now();
  }
  return false; // active
}

/**
 * Resolve the caller's OrgContext from the Better Auth session.
 * Returns null when unauthenticated or not a member of any organisation.
 * Deduped per request via React cache().
 */
export const resolveOrgContext = cache(
  async (): Promise<OrgContext | null> => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;

    const userId = session.user.id;
    let orgId = session.session.activeOrganizationId ?? null;

    let membership:
      | { id: string; organizationId: string; role: string }
      | undefined;

    if (orgId) {
      [membership] = await db
        .select({
          id: member.id,
          organizationId: member.organizationId,
          role: member.role,
        })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
        .limit(1);
    }

    if (!membership) {
      // Fallback: first membership; try to persist it as active.
      [membership] = await db
        .select({
          id: member.id,
          organizationId: member.organizationId,
          role: member.role,
        })
        .from(member)
        .where(eq(member.userId, userId))
        .limit(1);
      if (!membership) return null;
      orgId = membership.organizationId;
      try {
        await auth.api.setActiveOrganization({
          headers: await headers(),
          body: { organizationId: orgId },
        });
      } catch {
        // Setting cookies can fail inside a pure render; context still valid.
      }
    }

    const role = (ALL_ROLES as readonly string[]).includes(membership.role)
      ? (membership.role as Role)
      : null;
    if (!role || !orgId) return null;

    const [settingsRow] = await db
      .select({
        hidePricesFromWarehouse: organisationSettings.hidePricesFromWarehouse,
      })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, orgId))
      .limit(1);

    const [subRow] = await db
      .select({
        status: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, orgId))
      .limit(1);

    const warehouseRows = await db
      .select({ warehouseId: memberWarehouseAccess.warehouseId })
      .from(memberWarehouseAccess)
      .where(eq(memberWarehouseAccess.memberId, membership.id));

    const buyingPointRows = await db
      .select({ buyingPointId: memberBuyingPointAccess.buyingPointId })
      .from(memberBuyingPointAccess)
      .where(eq(memberBuyingPointAccess.memberId, membership.id));

    return {
      orgId,
      userId,
      role,
      restrictions: {
        warehouseIds:
          warehouseRows.length > 0
            ? warehouseRows.map((r) => r.warehouseId)
            : null,
        buyingPointIds:
          buyingPointRows.length > 0
            ? buyingPointRows.map((r) => r.buyingPointId)
            : null,
        hidePrices:
          role === "warehouse" &&
          (settingsRow?.hidePricesFromWarehouse ?? false),
      },
      readOnly: isReadOnly(subRow ?? null),
    };
  },
);
