import { and, asc, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  auditLog,
  commodities,
  member,
  organization,
  plans,
  purchases,
  salesOrders,
  subscriptions,
  suppliers,
  user,
  warehouses,
} from "@/db/schema";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import type {
  PlanInput,
  PlanUpdateInput,
  PlatformAuditQuery,
  PlatformOrgQuery,
  SetOrgReadOnlyInput,
} from "@/lib/validation/masterData";

/**
 * Platform-admin service (P1-B). Cross-tenant BY DESIGN — callers must sit
 * behind the platformAction guard / platform layout (user.is_platform_admin).
 * Never import this from org-scoped code.
 */

export type PlatformCtx = { userId: string };
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
];
export type Plan = typeof plans.$inferSelect;

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

async function mutate<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await (db as Tx).transaction(fn);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    if (pgCode(err) === "23505") throw new DomainError("DUPLICATE", "That code is already in use");
    throw err;
  }
}

/** Read-only rule (DATA-MODEL §subscriptions) — mirrors authz/resolve.ts. */
export function isSubscriptionReadOnly(
  sub: { status: SubscriptionStatus; trialEndsAt: Date | null } | null,
  at: Date = new Date(),
): boolean {
  if (!sub) return false;
  if (sub.status === "past_due" || sub.status === "cancelled") return true;
  if (sub.status === "trialing") return sub.trialEndsAt !== null && sub.trialEndsAt < at;
  return false;
}

// ── Health ───────────────────────────────────────────────────────────────────

export type HealthOverview = {
  organisations: number;
  users: number;
  platformAdmins: number;
  memberships: number;
  subscriptionsByStatus: Record<SubscriptionStatus, number>;
  expiredTrials: number;
  orgsWithoutSubscription: number;
};

export async function getHealthOverview(db: DbOrTx): Promise<HealthOverview> {
  const [[orgs], [users], [admins], [members], statusRows, [expired], [withSub]] = await Promise.all([
    db.select({ n: count() }).from(organization),
    db.select({ n: count() }).from(user),
    db.select({ n: count() }).from(user).where(eq(user.isPlatformAdmin, true)),
    db.select({ n: count() }).from(member),
    db
      .select({ status: subscriptions.status, n: count() })
      .from(subscriptions)
      .groupBy(subscriptions.status),
    db
      .select({ n: count() })
      .from(subscriptions)
      .where(and(eq(subscriptions.status, "trialing"), lt(subscriptions.trialEndsAt, new Date()))),
    db.select({ n: count() }).from(subscriptions),
  ]);
  const byStatus: Record<SubscriptionStatus, number> = {
    trialing: 0,
    active: 0,
    past_due: 0,
    cancelled: 0,
  };
  for (const r of statusRows) byStatus[r.status] = r.n;
  return {
    organisations: orgs?.n ?? 0,
    users: users?.n ?? 0,
    platformAdmins: admins?.n ?? 0,
    memberships: members?.n ?? 0,
    subscriptionsByStatus: byStatus,
    expiredTrials: expired?.n ?? 0,
    orgsWithoutSubscription: Math.max(0, (orgs?.n ?? 0) - (withSub?.n ?? 0)),
  };
}

// ── Organisations ────────────────────────────────────────────────────────────

export type OrgListRow = {
  id: string;
  name: string;
  slug: string | null;
  createdAt: Date;
  memberCount: number;
  subscriptionStatus: SubscriptionStatus | null;
  trialEndsAt: Date | null;
  planName: string | null;
  readOnly: boolean;
};

const memberCountSql = sql<number>`(select count(*)::int from ${member} where ${member.organizationId} = ${sql.raw('"organization"."id"')})`;

export async function listOrganisations(
  db: DbOrTx,
  query: PlatformOrgQuery,
): Promise<{ rows: OrgListRow[]; total: number; page: number; pageSize: number }> {
  const where: SQL | undefined = query.q
    ? or(ilike(organization.name, `%${query.q}%`), ilike(organization.slug, `%${query.q}%`))
    : undefined;
  const [totalRow] = await db.select({ n: count() }).from(organization).where(where);
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      memberCount: memberCountSql,
      subscriptionStatus: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      planName: plans.name,
    })
    .from(organization)
    .leftJoin(subscriptions, eq(subscriptions.organisationId, organization.id))
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(where)
    .orderBy(desc(organization.createdAt), asc(organization.name))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    rows: rows.map((r) => ({
      ...r,
      memberCount: Number(r.memberCount),
      readOnly: isSubscriptionReadOnly(
        r.subscriptionStatus ? { status: r.subscriptionStatus, trialEndsAt: r.trialEndsAt } : null,
      ),
    })),
    total: totalRow?.n ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export type OrgDetail = OrgListRow & {
  subscription: {
    id: string;
    planId: string;
    planCode: string | null;
    status: SubscriptionStatus;
    trialEndsAt: Date;
    currentPeriodEnd: Date | null;
  } | null;
  members: { id: string; userId: string; name: string; email: string; phoneNumber: string | null; role: string }[];
  usage: { commodities: number; warehouses: number; suppliers: number; purchases: number; salesOrders: number };
};

export async function getOrganisation(db: DbOrTx, organisationId: string): Promise<OrgDetail> {
  const [org] = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      memberCount: memberCountSql,
    })
    .from(organization)
    .where(eq(organization.id, organisationId))
    .limit(1);
  if (!org) throw new DomainError("NOT_FOUND", "Organisation not found");

  const [sub] = await db
    .select({
      id: subscriptions.id,
      planId: subscriptions.planId,
      planCode: plans.code,
      planName: plans.name,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.organisationId, organisationId))
    .limit(1);

  const members = await db
    .select({
      id: member.id,
      userId: member.userId,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organisationId))
    .orderBy(asc(user.name));

  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [nCommodities, nWarehouses, nSuppliers, nPurchases, nSales] = await Promise.all([
    n(db.select({ n: count() }).from(commodities).where(eq(commodities.organisationId, organisationId))),
    n(db.select({ n: count() }).from(warehouses).where(eq(warehouses.organisationId, organisationId))),
    n(db.select({ n: count() }).from(suppliers).where(eq(suppliers.organisationId, organisationId))),
    n(db.select({ n: count() }).from(purchases).where(eq(purchases.organisationId, organisationId))),
    n(db.select({ n: count() }).from(salesOrders).where(eq(salesOrders.organisationId, organisationId))),
  ]);

  return {
    ...org,
    memberCount: Number(org.memberCount),
    subscriptionStatus: sub?.status ?? null,
    trialEndsAt: sub?.trialEndsAt ?? null,
    planName: sub?.planName ?? null,
    readOnly: isSubscriptionReadOnly(sub ? { status: sub.status, trialEndsAt: sub.trialEndsAt } : null),
    subscription: sub
      ? {
          id: sub.id,
          planId: sub.planId,
          planCode: sub.planCode,
          status: sub.status,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodEnd: sub.currentPeriodEnd,
        }
      : null,
    members,
    usage: {
      commodities: nCommodities,
      warehouses: nWarehouses,
      suppliers: nSuppliers,
      purchases: nPurchases,
      salesOrders: nSales,
    },
  };
}

/**
 * Platform read-only toggle: read-only → status past_due; writable → active.
 * Audited into the TARGET organisation's audit log, attributed to the admin.
 */
export async function setOrganisationReadOnly(
  db: DbOrTx,
  pctx: PlatformCtx,
  input: SetOrgReadOnlyInput,
): Promise<{ status: SubscriptionStatus }> {
  return mutate(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, input.organisationId))
      .limit(1)
      .for("update");
    if (!before) throw new DomainError("NO_SUBSCRIPTION", "Organisation has no subscription");
    const status: SubscriptionStatus = input.readOnly ? "past_due" : "active";
    const [after] = await tx
      .update(subscriptions)
      .set({ status, updatedAt: new Date() })
      .where(eq(subscriptions.id, before.id))
      .returning();
    await writeAudit(
      tx,
      { orgId: input.organisationId, userId: pctx.userId },
      { action: "update", tableName: "subscriptions", recordId: before.id, before, after },
    );
    return { status };
  });
}

// ── Plans ────────────────────────────────────────────────────────────────────

export async function listPlans(db: DbOrTx): Promise<(Plan & { subscriptionCount: number })[]> {
  const rows = await db
    .select({
      plan: plans,
      subscriptionCount: sql<number>`(select count(*)::int from ${subscriptions} where ${subscriptions.planId} = ${sql.raw('"plans"."id"')})`,
    })
    .from(plans)
    .orderBy(asc(plans.monthlyPriceKobo), asc(plans.code));
  return rows.map((r) => ({ ...r.plan, subscriptionCount: Number(r.subscriptionCount) }));
}

export async function getPlan(db: DbOrTx, id: string): Promise<Plan> {
  const [row] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Plan not found");
  return row;
}

// plans are global (no organisation_id) and audit_log.organisation_id is NOT
// NULL, so plan changes cannot be written to audit_log; they are logged here.
function logPlanChange(pctx: PlatformCtx, action: string, before: unknown, after: unknown) {
  console.info("[platform] plan", action, JSON.stringify({ by: pctx.userId, before, after }));
}

export async function createPlan(db: DbOrTx, pctx: PlatformCtx, input: PlanInput): Promise<Plan> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(plans)
      .values({
        code: input.code,
        name: input.name,
        monthlyPriceKobo: input.monthlyPriceKobo,
        userLimit: input.userLimit,
        paystackPlanCode: input.paystackPlanCode,
        active: input.active,
      })
      .returning();
    logPlanChange(pctx, "create", null, row);
    return row;
  });
}

export async function updatePlan(db: DbOrTx, pctx: PlatformCtx, input: PlanUpdateInput): Promise<Plan> {
  return mutate(db, async (tx) => {
    const before = await getPlan(tx, input.id);
    const [row] = await tx
      .update(plans)
      .set({
        code: input.code,
        name: input.name,
        monthlyPriceKobo: input.monthlyPriceKobo,
        userLimit: input.userLimit,
        paystackPlanCode: input.paystackPlanCode,
        active: input.active,
        updatedAt: new Date(),
      })
      .where(eq(plans.id, input.id))
      .returning();
    logPlanChange(pctx, "update", before, row);
    return row;
  });
}

export async function setPlanActive(
  db: DbOrTx,
  pctx: PlatformCtx,
  input: { id: string; active: boolean },
): Promise<Plan> {
  return mutate(db, async (tx) => {
    const before = await getPlan(tx, input.id);
    const [row] = await tx
      .update(plans)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(plans.id, input.id))
      .returning();
    logPlanChange(pctx, "set-active", before, row);
    return row;
  });
}

// ── Cross-tenant audit ───────────────────────────────────────────────────────

export type PlatformAuditRow = {
  id: string;
  organisationId: string;
  organisationName: string | null;
  userId: string | null;
  userName: string | null;
  action: string;
  tableName: string;
  recordId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

/** Date filters are Africa/Lagos calendar days (UTC+1, no DST). */
function lagosDayStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+01:00`);
}

export async function listAuditLog(
  db: DbOrTx,
  query: PlatformAuditQuery,
): Promise<{ rows: PlatformAuditRow[]; total: number; page: number; pageSize: number }> {
  const where: SQL[] = [];
  if (query.organisationId) where.push(eq(auditLog.organisationId, query.organisationId));
  if (query.tableName) where.push(eq(auditLog.tableName, query.tableName));
  if (query.from) where.push(gte(auditLog.createdAt, lagosDayStart(query.from)));
  if (query.to) {
    const end = lagosDayStart(query.to);
    end.setUTCDate(end.getUTCDate() + 1);
    where.push(lt(auditLog.createdAt, end));
  }
  const cond = where.length ? and(...where) : undefined;
  const [totalRow] = await db.select({ n: count() }).from(auditLog).where(cond);
  const rows = await db
    .select({
      id: auditLog.id,
      organisationId: auditLog.organisationId,
      organisationName: organization.name,
      userId: auditLog.userId,
      userName: user.name,
      action: auditLog.action,
      tableName: auditLog.tableName,
      recordId: auditLog.recordId,
      before: auditLog.before,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(organization, eq(organization.id, auditLog.organisationId))
    .leftJoin(user, eq(user.id, auditLog.userId))
    .where(cond)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { rows, total: totalRow?.n ?? 0, page: query.page, pageSize: query.pageSize };
}

export async function listAuditTableNames(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tableName: auditLog.tableName })
    .from(auditLog)
    .orderBy(asc(auditLog.tableName));
  return rows.map((r) => r.tableName);
}

export async function listOrganisationOptions(db: DbOrTx): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .orderBy(asc(organization.name));
}
