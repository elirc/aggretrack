import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { DbOrTx } from "@/db/client";
import {
  account,
  buyingPoints,
  member,
  memberBuyingPointAccess,
  memberWarehouseAccess,
  organisationSettings,
  organization,
  plans,
  subscriptions,
  user,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { ALL_ROLES, can, type Permission, type Role } from "@/lib/authz/permissions";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import type {
  AddMemberInput,
  ChangeRoleInput,
  MemberRestrictionsInput,
  OrgSettingsInput,
  RemoveMemberInput,
} from "@/lib/validation/users";

/**
 * Users, roles, member restrictions and organisation settings.
 *
 * Design note (documented deviation): Better Auth's organization plugin only
 * knows its default roles (owner/admin/member) unless an access-control
 * config is wired, so auth.api.addMember / updateMemberRole would reject our
 * business roles. Per DECISIONS #10 the role string on member.role is ours,
 * so member/user rows are written directly here (same shapes Better Auth
 * uses: text ids, credential account with better-auth's hashPassword).
 *
 * No "server-only" import: this module is exercised by integration tests.
 * Every function re-checks the permission matrix (defence in depth on top
 * of the orgAction guard) and scopes every query by ctx.orgId.
 */

/** Suffix of the placeholder email Better Auth's phone sign-up assigns. */
export const PHONE_EMAIL_DOMAIN = "@phone.aggretrack.local";

export function tempEmailForPhone(phone: string): string {
  return `${phone.replace(/[^0-9]/g, "")}${PHONE_EMAIL_DOMAIN}`;
}

export function assertCan(ctx: OrgContext, permission: Permission): void {
  if (!can(ctx.role, permission)) {
    throw new DomainError("FORBIDDEN", `Role ${ctx.role} lacks ${permission}`);
  }
}

function assertWritable(ctx: OrgContext): void {
  if (ctx.readOnly) throw new DomainError("READ_ONLY");
}

const TRIAL_DAYS = 14;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type MemberRow = {
  memberId: string;
  userId: string;
  name: string;
  email: string | null; // null when it is the phone placeholder
  phoneNumber: string | null;
  role: Role;
  createdAt: Date;
  warehouseIds: string[] | null;
  buyingPointIds: string[] | null;
};

export type Restrictions = {
  warehouseIds: string[] | null;
  buyingPointIds: string[] | null;
};

function asRole(r: string): Role {
  return (ALL_ROLES as readonly string[]).includes(r) ? (r as Role) : "sales";
}

export async function listMembers(db: DbOrTx, ctx: OrgContext): Promise<MemberRow[]> {
  assertCan(ctx, "users.read");
  const rows = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, ctx.orgId))
    .orderBy(asc(member.createdAt));

  const wh = await db
    .select({ memberId: memberWarehouseAccess.memberId, id: memberWarehouseAccess.warehouseId })
    .from(memberWarehouseAccess)
    .where(eq(memberWarehouseAccess.organisationId, ctx.orgId));
  const bp = await db
    .select({ memberId: memberBuyingPointAccess.memberId, id: memberBuyingPointAccess.buyingPointId })
    .from(memberBuyingPointAccess)
    .where(eq(memberBuyingPointAccess.organisationId, ctx.orgId));

  const group = (list: { memberId: string; id: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of list) {
      const arr = m.get(r.memberId) ?? [];
      arr.push(r.id);
      m.set(r.memberId, arr);
    }
    return m;
  };
  const whBy = group(wh);
  const bpBy = group(bp);

  return rows.map((r) => ({
    memberId: r.memberId,
    userId: r.userId,
    name: r.name,
    email: r.email.endsWith(PHONE_EMAIL_DOMAIN) ? null : r.email,
    phoneNumber: r.phoneNumber,
    role: asRole(r.role),
    createdAt: r.createdAt,
    warehouseIds: whBy.get(r.memberId) ?? null,
    buyingPointIds: bpBy.get(r.memberId) ?? null,
  }));
}

/**
 * The restriction lookup resolveOrgContext performs, for one member of
 * ctx's organisation. Empty access rows ⇒ null (unrestricted).
 */
export async function getMemberRestrictions(
  db: DbOrTx,
  ctx: OrgContext,
  memberId: string,
): Promise<Restrictions> {
  await loadMember(db, ctx, memberId);
  return readRestrictions(db, ctx.orgId, memberId);
}

async function readRestrictions(
  db: DbOrTx,
  orgId: string,
  memberId: string,
): Promise<Restrictions> {
  const wh = await db
    .select({ id: memberWarehouseAccess.warehouseId })
    .from(memberWarehouseAccess)
    .where(
      and(
        eq(memberWarehouseAccess.organisationId, orgId),
        eq(memberWarehouseAccess.memberId, memberId),
      ),
    );
  const bp = await db
    .select({ id: memberBuyingPointAccess.buyingPointId })
    .from(memberBuyingPointAccess)
    .where(
      and(
        eq(memberBuyingPointAccess.organisationId, orgId),
        eq(memberBuyingPointAccess.memberId, memberId),
      ),
    );
  return {
    warehouseIds: wh.length > 0 ? wh.map((r) => r.id).sort() : null,
    buyingPointIds: bp.length > 0 ? bp.map((r) => r.id).sort() : null,
  };
}

export type AccessOptions = {
  warehouses: { id: string; name: string }[];
  buyingPoints: { id: string; name: string }[];
};

export async function listAccessOptions(db: DbOrTx, ctx: OrgContext): Promise<AccessOptions> {
  assertCan(ctx, "users.read");
  const [whs, bps] = await Promise.all([
    db
      .select({ id: warehouses.id, name: warehouses.name })
      .from(warehouses)
      .where(eq(warehouses.organisationId, ctx.orgId))
      .orderBy(asc(warehouses.name)),
    db
      .select({ id: buyingPoints.id, name: buyingPoints.name })
      .from(buyingPoints)
      .where(eq(buyingPoints.organisationId, ctx.orgId))
      .orderBy(asc(buyingPoints.name)),
  ]);
  return { warehouses: whs, buyingPoints: bps };
}

async function loadMember(db: DbOrTx, ctx: OrgContext, memberId: string) {
  const [row] = await db
    .select({ id: member.id, userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.organizationId, ctx.orgId)))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Member not found");
  return row;
}

async function ownerCount(db: DbOrTx, orgId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")));
  return Number(r?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create (or attach) a user and make them a member with the given role.
 * Phone is the primary login (OTP); email+password is optional.
 * An existing user with the same phone/email is attached, never modified.
 */
export async function addMember(
  db: DbOrTx,
  ctx: OrgContext,
  input: AddMemberInput,
): Promise<{ memberId: string; userId: string; createdUser: boolean }> {
  assertCan(ctx, "users.manage");
  assertWritable(ctx);
  if (input.role === "owner" && ctx.role !== "owner") {
    throw new DomainError("OWNER_ONLY", "Only an owner can add another owner");
  }

  const passwordHash = input.password ? await hashPassword(input.password) : null;

  return db.transaction(async (tx) => {
    // Plan user limit (if the org has a subscription with a plan).
    const [limitRow] = await tx
      .select({ userLimit: plans.userLimit })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.organisationId, ctx.orgId))
      .limit(1);
    if (limitRow) {
      const [c] = await tx
        .select({ n: count() })
        .from(member)
        .where(eq(member.organizationId, ctx.orgId));
      if (Number(c?.n ?? 0) >= limitRow.userLimit) {
        throw new DomainError("USER_LIMIT_REACHED", "Plan user limit reached");
      }
    }

    const matchers = [eq(user.phoneNumber, input.phone)];
    if (input.email) matchers.push(eq(user.email, input.email));
    const existing = await tx
      .select({ id: user.id })
      .from(user)
      .where(or(...matchers))
      .limit(2);
    if (existing.length > 1) {
      throw new DomainError("CONFLICT", "Phone and email belong to different users");
    }

    let userId: string;
    let createdUser = false;
    const now = new Date();

    if (existing[0]) {
      userId = existing[0].id;
      const [already] = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, ctx.orgId), eq(member.userId, userId)))
        .limit(1);
      if (already) throw new DomainError("ALREADY_MEMBER", "Already a member");
    } else {
      userId = randomUUID();
      createdUser = true;
      await tx.insert(user).values({
        id: userId,
        name: input.name,
        email: input.email ?? tempEmailForPhone(input.phone),
        emailVerified: false,
        phoneNumber: input.phone,
        // The owner vouches for the number; first OTP login signs them in.
        phoneNumberVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      if (passwordHash) {
        await tx.insert(account).values({
          id: randomUUID(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const memberId = randomUUID();
    await tx.insert(member).values({
      id: memberId,
      organizationId: ctx.orgId,
      userId,
      role: input.role,
      createdAt: now,
    });

    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "member",
      recordId: memberId,
      after: {
        userId,
        name: input.name,
        phoneNumber: input.phone,
        email: input.email ?? null,
        role: input.role,
        createdUser,
        hasPassword: Boolean(passwordHash),
      },
    });

    return { memberId, userId, createdUser };
  });
}

export async function changeMemberRole(
  db: DbOrTx,
  ctx: OrgContext,
  input: ChangeRoleInput,
): Promise<{ memberId: string; role: Role }> {
  assertCan(ctx, "users.manage");
  assertWritable(ctx);

  return db.transaction(async (tx) => {
    const target = await loadMember(tx, ctx, input.memberId);
    if (target.role === input.role) return { memberId: target.id, role: input.role };

    if ((target.role === "owner" || input.role === "owner") && ctx.role !== "owner") {
      throw new DomainError("OWNER_ONLY", "Only an owner can change owner roles");
    }
    if (target.role === "owner" && (await ownerCount(tx, ctx.orgId)) <= 1) {
      throw new DomainError("LAST_OWNER", "An organisation needs at least one owner");
    }

    await tx
      .update(member)
      .set({ role: input.role })
      .where(and(eq(member.id, target.id), eq(member.organizationId, ctx.orgId)));

    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "member",
      recordId: target.id,
      before: { role: target.role },
      after: { role: input.role },
    });
    return { memberId: target.id, role: input.role };
  });
}

export async function removeMember(
  db: DbOrTx,
  ctx: OrgContext,
  input: RemoveMemberInput,
): Promise<{ memberId: string }> {
  assertCan(ctx, "users.manage");
  assertWritable(ctx);

  return db.transaction(async (tx) => {
    const target = await loadMember(tx, ctx, input.memberId);
    if (target.userId === ctx.userId) {
      throw new DomainError("CANNOT_REMOVE_SELF", "You cannot remove yourself");
    }
    if (target.role === "owner") {
      if (ctx.role !== "owner") {
        throw new DomainError("OWNER_ONLY", "Only an owner can remove an owner");
      }
      if ((await ownerCount(tx, ctx.orgId)) <= 1) {
        throw new DomainError("LAST_OWNER", "An organisation needs at least one owner");
      }
    }
    const before = await readRestrictions(tx, ctx.orgId, target.id);

    // Access rows cascade on member delete; delete explicitly anyway so the
    // org filter is visible.
    await tx
      .delete(memberWarehouseAccess)
      .where(
        and(
          eq(memberWarehouseAccess.organisationId, ctx.orgId),
          eq(memberWarehouseAccess.memberId, target.id),
        ),
      );
    await tx
      .delete(memberBuyingPointAccess)
      .where(
        and(
          eq(memberBuyingPointAccess.organisationId, ctx.orgId),
          eq(memberBuyingPointAccess.memberId, target.id),
        ),
      );
    await tx
      .delete(member)
      .where(and(eq(member.id, target.id), eq(member.organizationId, ctx.orgId)));

    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "member",
      recordId: target.id,
      before: { userId: target.userId, role: target.role, ...before },
      after: null,
    });
    return { memberId: target.id };
  });
}

/** Replace a member's warehouse / buying-point access. Empty = unrestricted. */
export async function setMemberRestrictions(
  db: DbOrTx,
  ctx: OrgContext,
  input: MemberRestrictionsInput,
): Promise<Restrictions> {
  assertCan(ctx, "users.manage");
  assertWritable(ctx);
  const warehouseIds = [...new Set(input.warehouseIds)];
  const buyingPointIds = [...new Set(input.buyingPointIds)];

  return db.transaction(async (tx) => {
    const target = await loadMember(tx, ctx, input.memberId);
    if (target.role === "owner" && ctx.role !== "owner") {
      throw new DomainError("OWNER_ONLY", "Only an owner can restrict an owner");
    }

    if (warehouseIds.length > 0) {
      const found = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(eq(warehouses.organisationId, ctx.orgId), inArray(warehouses.id, warehouseIds)),
        );
      if (found.length !== warehouseIds.length) {
        throw new DomainError("NOT_FOUND", "Unknown warehouse");
      }
    }
    if (buyingPointIds.length > 0) {
      const found = await tx
        .select({ id: buyingPoints.id })
        .from(buyingPoints)
        .where(
          and(
            eq(buyingPoints.organisationId, ctx.orgId),
            inArray(buyingPoints.id, buyingPointIds),
          ),
        );
      if (found.length !== buyingPointIds.length) {
        throw new DomainError("NOT_FOUND", "Unknown buying point");
      }
    }

    const before = await readRestrictions(tx, ctx.orgId, target.id);

    await tx
      .delete(memberWarehouseAccess)
      .where(
        and(
          eq(memberWarehouseAccess.organisationId, ctx.orgId),
          eq(memberWarehouseAccess.memberId, target.id),
        ),
      );
    await tx
      .delete(memberBuyingPointAccess)
      .where(
        and(
          eq(memberBuyingPointAccess.organisationId, ctx.orgId),
          eq(memberBuyingPointAccess.memberId, target.id),
        ),
      );
    if (warehouseIds.length > 0) {
      await tx.insert(memberWarehouseAccess).values(
        warehouseIds.map((warehouseId) => ({
          organisationId: ctx.orgId,
          memberId: target.id,
          warehouseId,
        })),
      );
    }
    if (buyingPointIds.length > 0) {
      await tx.insert(memberBuyingPointAccess).values(
        buyingPointIds.map((buyingPointId) => ({
          organisationId: ctx.orgId,
          memberId: target.id,
          buyingPointId,
        })),
      );
    }

    const after = await readRestrictions(tx, ctx.orgId, target.id);
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "member_access",
      recordId: target.id,
      before,
      after,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Organisation settings
// ---------------------------------------------------------------------------

export type OrgSettingsView = {
  name: string;
  slug: string | null;
  adjustmentApprovalThresholdKg: string;
  lowStockThresholdKg: string;
  oldStockDays: number;
  capacityAlertPercent: number;
  invoiceTaxPercent: string;
  hidePricesFromWarehouse: boolean;
};

/** Strip trailing zeros from numeric strings for form display ("50.000" → "50"). */
function trimNumeric(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export async function getOrgSettings(db: DbOrTx, ctx: OrgContext): Promise<OrgSettingsView> {
  const [org] = await db
    .select({ name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, ctx.orgId))
    .limit(1);
  if (!org) throw new DomainError("NOT_FOUND", "Organisation not found");
  const [s] = await db
    .select()
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, ctx.orgId))
    .limit(1);
  return {
    name: org.name,
    slug: org.slug,
    adjustmentApprovalThresholdKg: trimNumeric(s?.adjustmentApprovalThresholdKg ?? "50"),
    lowStockThresholdKg: trimNumeric(s?.lowStockThresholdKg ?? "1000"),
    oldStockDays: s?.oldStockDays ?? 90,
    capacityAlertPercent: s?.capacityAlertPercent ?? 90,
    invoiceTaxPercent: trimNumeric(s?.invoiceTaxPercent ?? "0"),
    hidePricesFromWarehouse: s?.hidePricesFromWarehouse ?? false,
  };
}

export async function updateOrgSettings(
  db: DbOrTx,
  ctx: OrgContext,
  input: OrgSettingsInput,
): Promise<OrgSettingsView> {
  assertCan(ctx, "org.settings");
  assertWritable(ctx);

  return db.transaction(async (tx) => {
    const before = await getOrgSettings(tx, ctx);
    const values = {
      adjustmentApprovalThresholdKg: input.adjustmentApprovalThresholdKg,
      lowStockThresholdKg: input.lowStockThresholdKg,
      oldStockDays: input.oldStockDays,
      capacityAlertPercent: input.capacityAlertPercent,
      invoiceTaxPercent: input.invoiceTaxPercent,
      hidePricesFromWarehouse: input.hidePricesFromWarehouse,
    };
    await tx
      .insert(organisationSettings)
      .values({ organisationId: ctx.orgId, ...values })
      .onConflictDoUpdate({
        target: organisationSettings.organisationId,
        set: { ...values, updatedAt: new Date() },
      });
    if (input.name !== before.name) {
      await tx
        .update(organization)
        .set({ name: input.name })
        .where(eq(organization.id, ctx.orgId));
    }
    const after = await getOrgSettings(tx, ctx);
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "organisation_settings",
      recordId: ctx.orgId,
      before,
      after,
    });
    return after;
  });
}

/** The org-wide "hide prices from warehouse keepers" switch on its own. */
export async function setHidePricesFromWarehouse(
  db: DbOrTx,
  ctx: OrgContext,
  hide: boolean,
): Promise<{ hidePricesFromWarehouse: boolean }> {
  assertCan(ctx, "org.settings");
  assertWritable(ctx);
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select({ hide: organisationSettings.hidePricesFromWarehouse })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, ctx.orgId))
      .limit(1);
    const before = s?.hide ?? false;
    await tx
      .insert(organisationSettings)
      .values({ organisationId: ctx.orgId, hidePricesFromWarehouse: hide })
      .onConflictDoUpdate({
        target: organisationSettings.organisationId,
        set: { hidePricesFromWarehouse: hide, updatedAt: new Date() },
      });
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "organisation_settings",
      recordId: ctx.orgId,
      before: { hidePricesFromWarehouse: before },
      after: { hidePricesFromWarehouse: hide },
    });
    return { hidePricesFromWarehouse: hide };
  });
}

/**
 * Called right after Better Auth created the organisation (register flow).
 * Idempotent: inserts the default organisation_settings row and a trialing
 * subscription on the cheapest active plan (creating a 'starter' plan when
 * the catalogue is empty), then audits the organisation creation.
 */
export async function initialiseOrganisation(
  db: DbOrTx,
  ctx: OrgContext,
): Promise<{ created: boolean; subscriptionId: string }> {
  assertCan(ctx, "org.settings");

  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organization.id, name: organization.name, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, ctx.orgId))
      .limit(1);
    if (!org) throw new DomainError("NOT_FOUND", "Organisation not found");

    const insertedSettings = await tx
      .insert(organisationSettings)
      .values({ organisationId: ctx.orgId })
      .onConflictDoNothing()
      .returning({ id: organisationSettings.organisationId });

    const [existingSub] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, ctx.orgId))
      .limit(1);
    if (existingSub) {
      return { created: false, subscriptionId: existingSub.id };
    }

    let [plan] = await tx
      .select({ id: plans.id, code: plans.code })
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.monthlyPriceKobo))
      .limit(1);
    if (!plan) {
      await tx
        .insert(plans)
        .values({
          code: "starter",
          name: "Starter",
          monthlyPriceKobo: 2_500_000,
          userLimit: 5,
        })
        .onConflictDoNothing();
      [plan] = await tx
        .select({ id: plans.id, code: plans.code })
        .from(plans)
        .where(eq(plans.code, "starter"))
        .limit(1);
    }
    if (!plan) throw new DomainError("NO_PLAN", "No plan available");

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        organisationId: ctx.orgId,
        planId: plan.id,
        status: "trialing",
        trialEndsAt,
      })
      .returning({ id: subscriptions.id });

    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "organization",
      recordId: ctx.orgId,
      after: {
        name: org.name,
        slug: org.slug,
        settingsCreated: insertedSettings.length > 0,
        subscription: { id: sub.id, planCode: plan.code, status: "trialing", trialEndsAt },
      },
    });

    return { created: true, subscriptionId: sub.id };
  });
}
