import { and, asc, eq, isNull } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { auditLog, member, plans, subscriptions, user } from "@/db/schema";
import { getPaymentsAdapter, type PaymentsAdapter, type PaystackEvent } from "@/adapters/payments";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import type { StartCheckoutInput } from "@/lib/validation/billing";
import { zUuid } from "@/lib/validation/common";

import { assertCan, inTx, notFound } from "./suppliers";

/**
 * Billing (P4-C) — ARCHITECTURE §Billing / read-only, INTEGRATIONS §4.
 *
 * - One `subscriptions` row per org. Read-only is DERIVED (never stored):
 *   past_due / cancelled, or trialing with trial_ends_at in the past. The
 *   same rule lives in src/lib/authz/resolve.ts (the guard's source of truth);
 *   `deriveBillingStatus` mirrors it for the billing page and tests.
 * - Paystack webhooks drive status. `applyWebhookEvent` is SEMANTICALLY
 *   idempotent: every transition is "set state to X" computed only from the
 *   event payload + current row, so replaying an event leaves the row (and
 *   the audit log) unchanged. There is no processed-events table in the
 *   frozen schema, so idempotency is by state, not by event id.
 * - No "server-only" import: exercised by integration tests.
 */

export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionStatus = Subscription["status"];

export type ReadOnlyReason = "trial_expired" | "past_due" | "cancelled" | null;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mirror of resolve.ts isReadOnly, plus the reason for the UI. */
export function deriveBillingStatus(
  sub: Pick<Subscription, "status" | "trialEndsAt"> | null,
  now: Date = new Date(),
): { readOnly: boolean; reason: ReadOnlyReason } {
  if (!sub) return { readOnly: false, reason: null };
  if (sub.status === "past_due") return { readOnly: true, reason: "past_due" };
  if (sub.status === "cancelled") return { readOnly: true, reason: "cancelled" };
  if (sub.status === "trialing" && sub.trialEndsAt.getTime() < now.getTime()) {
    return { readOnly: true, reason: "trial_expired" };
  }
  return { readOnly: false, reason: null };
}

export type BillingState = {
  plan: Pick<Plan, "id" | "code" | "name" | "monthlyPriceKobo" | "userLimit"> | null;
  subscription: Pick<
    Subscription,
    "status" | "trialEndsAt" | "currentPeriodEnd" | "paystackSubscriptionCode"
  > & { canCancel: boolean } | null;
  /** Whole days left in the trial (ceil), 0 when expired; null when not trialing. */
  trialDaysLeft: number | null;
  readOnly: boolean;
  reason: ReadOnlyReason;
};

export async function getBillingState(
  db: DbOrTx,
  ctx: OrgContext,
  now: Date = new Date(),
): Promise<BillingState> {
  const [row] = await db
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.organisationId, ctx.orgId))
    .limit(1);
  if (!row) {
    return { plan: null, subscription: null, trialDaysLeft: null, readOnly: false, reason: null };
  }
  const { sub, plan } = row;
  const { readOnly, reason } = deriveBillingStatus(sub, now);
  const trialDaysLeft =
    sub.status === "trialing"
      ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY_MS))
      : null;
  return {
    plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      monthlyPriceKobo: plan.monthlyPriceKobo,
      userLimit: plan.userLimit,
    },
    subscription: {
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      paystackSubscriptionCode: sub.paystackSubscriptionCode,
      canCancel:
        sub.status !== "cancelled" && !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken,
    },
    trialDaysLeft,
    readOnly,
    reason,
  };
}

/** Active plans for the plan picker (global catalogue — no org scope). */
export async function listActivePlans(
  db: DbOrTx,
): Promise<Pick<Plan, "id" | "code" | "name" | "monthlyPriceKobo" | "userLimit">[]> {
  return db
    .select({
      id: plans.id,
      code: plans.code,
      name: plans.name,
      monthlyPriceKobo: plans.monthlyPriceKobo,
      userLimit: plans.userLimit,
    })
    .from(plans)
    .where(eq(plans.active, true))
    .orderBy(asc(plans.monthlyPriceKobo), asc(plans.name));
}

// ── checkout ─────────────────────────────────────────────────────────────────

/** Ensure the plan row has a Paystack plan code (created lazily, persisted race-safely). */
async function ensurePaystackPlanCode(db: DbOrTx, plan: Plan, adapter: PaymentsAdapter): Promise<string> {
  if (plan.paystackPlanCode) return plan.paystackPlanCode;
  const { planCode } = await adapter.createPlan({
    name: plan.name,
    amountKobo: plan.monthlyPriceKobo,
    interval: "monthly",
  });
  // Only fill when still empty: a concurrent checkout may have won the race.
  await db
    .update(plans)
    .set({ paystackPlanCode: planCode, updatedAt: new Date() })
    .where(and(eq(plans.id, plan.id), isNull(plans.paystackPlanCode)));
  const [fresh] = await db
    .select({ code: plans.paystackPlanCode })
    .from(plans)
    .where(eq(plans.id, plan.id))
    .limit(1);
  return fresh?.code ?? planCode;
}

export type CheckoutResult = { checkoutUrl: string; reference: string };

/**
 * Start Paystack hosted checkout for a plan. Deliberately allowed while the
 * org is read-only — paying is the way out of read-only.
 */
export async function startCheckout(
  db: DbOrTx,
  ctx: OrgContext,
  input: StartCheckoutInput,
  adapter: PaymentsAdapter = getPaymentsAdapter(),
): Promise<CheckoutResult> {
  assertCan(ctx, "billing.manage");
  const [plan] = await db.select().from(plans).where(eq(plans.id, input.planId)).limit(1);
  if (!plan || !plan.active) notFound("Plan");

  const [sub] = await db
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.organisationId, ctx.orgId))
    .limit(1);
  if (!sub) throw new DomainError("NO_SUBSCRIPTION", "Organisation has no subscription record");
  if (sub.status === "active") {
    throw new DomainError("ALREADY_ACTIVE", "This organisation already has an active subscription");
  }

  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, ctx.userId)).limit(1);
  if (!owner?.email) throw new DomainError("NO_EMAIL", "Add an email address to your profile to subscribe");

  const planCode = await ensurePaystackPlanCode(db, plan, adapter);
  const result = await adapter.initializeSubscription({
    email: owner.email,
    planCode,
    amountKobo: plan.monthlyPriceKobo,
    metadata: { org_id: ctx.orgId, plan_id: plan.id },
  });
  await writeAudit(db, ctx, {
    action: "update",
    tableName: "subscriptions",
    recordId: sub.id,
    after: { checkoutStarted: { planId: plan.id, planCode, reference: result.reference } },
  });
  return result;
}

// ── cancel ───────────────────────────────────────────────────────────────────

export async function cancelSubscription(
  db: DbOrTx,
  ctx: OrgContext,
  adapter: PaymentsAdapter = getPaymentsAdapter(),
): Promise<{ status: SubscriptionStatus }> {
  assertCan(ctx, "billing.manage");
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organisationId, ctx.orgId))
    .limit(1);
  if (!sub) throw new DomainError("NO_SUBSCRIPTION", "Organisation has no subscription record");
  if (sub.status === "cancelled") return { status: "cancelled" };
  if (!sub.paystackSubscriptionCode || !sub.paystackEmailToken) {
    throw new DomainError("NO_PAID_SUBSCRIPTION", "There is no paid subscription to cancel");
  }
  await adapter.cancelSubscription({
    subscriptionCode: sub.paystackSubscriptionCode,
    emailToken: sub.paystackEmailToken,
  });
  // Same set-state the subscription.disable webhook applies (idempotent with it).
  const [after] = await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  await writeAudit(db, ctx, { action: "cancel", tableName: "subscriptions", recordId: sub.id, before: sub, after });
  return { status: "cancelled" };
}

// ── webhooks ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  if (typeof v === "string") {
    // Paystack sometimes delivers metadata as a JSON string.
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === "object" && parsed !== null ? (parsed as Obj) : null;
    } catch {
      return null;
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function date(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addOneMonth(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + 1);
  return out;
}

type ParsedEvent = {
  event: string;
  orgIdHint: string | null;
  planIdHint: string | null;
  planCode: string | null;
  subscriptionCode: string | null;
  emailToken: string | null;
  customerCode: string | null;
  customerEmail: string | null;
  nextPaymentDate: Date | null;
  paidAt: Date | null;
};

function parseEvent(e: PaystackEvent): ParsedEvent {
  const d = e.data;
  const metadata = asObj(d.metadata);
  const plan = asObj(d.plan);
  const customer = asObj(d.customer);
  const subscription = asObj(d.subscription);
  return {
    event: e.event,
    orgIdHint: str(metadata?.org_id) ?? str(metadata?.orgId),
    planIdHint: str(metadata?.plan_id) ?? str(metadata?.planId),
    planCode: str(plan?.plan_code) ?? str(d.plan_code) ?? (typeof d.plan === "string" ? str(d.plan) : null),
    subscriptionCode: str(d.subscription_code) ?? str(subscription?.subscription_code),
    emailToken: str(d.email_token) ?? str(subscription?.email_token),
    customerCode: str(customer?.customer_code),
    customerEmail: str(customer?.email),
    nextPaymentDate: date(d.next_payment_date) ?? date(subscription?.next_payment_date),
    paidAt: date(d.paid_at) ?? date(d.paidAt),
  };
}

/** Find the org a Paystack event belongs to. Order: metadata → subscription code → customer code → owner email. */
async function resolveSubscription(db: DbOrTx, p: ParsedEvent): Promise<Subscription | null> {
  const by = async (cond: ReturnType<typeof eq>) => {
    const [row] = await db.select().from(subscriptions).where(cond).limit(1);
    return row ?? null;
  };
  if (p.orgIdHint && p.orgIdHint.length <= 200) {
    const row = await by(eq(subscriptions.organisationId, p.orgIdHint));
    if (row) return row;
  }
  if (p.subscriptionCode) {
    const row = await by(eq(subscriptions.paystackSubscriptionCode, p.subscriptionCode));
    if (row) return row;
  }
  if (p.customerCode) {
    const row = await by(eq(subscriptions.paystackCustomerCode, p.customerCode));
    if (row) return row;
  }
  if (p.customerEmail) {
    // Only unambiguous: the email belongs to an owner of exactly one org.
    const owned = await db
      .select({ orgId: member.organizationId })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(user.email, p.customerEmail), eq(member.role, "owner")));
    if (owned.length === 1) return by(eq(subscriptions.organisationId, owned[0].orgId));
  }
  return null;
}

async function planIdFor(db: DbOrTx, p: ParsedEvent): Promise<string | null> {
  if (p.planCode) {
    const [row] = await db.select({ id: plans.id }).from(plans).where(eq(plans.paystackPlanCode, p.planCode)).limit(1);
    if (row) return row.id;
  }
  if (p.planIdHint && zUuid.safeParse(p.planIdHint).success) {
    const [row] = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, p.planIdHint)).limit(1);
    if (row) return row.id;
  }
  return null;
}

type Patch = Partial<
  Pick<
    Subscription,
    | "status"
    | "planId"
    | "currentPeriodEnd"
    | "paystackCustomerCode"
    | "paystackSubscriptionCode"
    | "paystackEmailToken"
  >
>;

export type WebhookOutcome = {
  event: string;
  outcome: "applied" | "unchanged" | "ignored";
  orgId: string | null;
  status?: SubscriptionStatus;
  note?: string;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Later of two optional dates (period end never rolls backwards on a stale replay). */
function laterOf(current: Date | null, next: Date | null): Date | null {
  if (!next) return current;
  if (!current) return next;
  return next.getTime() > current.getTime() ? next : current;
}

/** Decide the target state for one event. Returns null to ignore. */
async function planTransition(
  db: DbOrTx,
  sub: Subscription,
  p: ParsedEvent,
): Promise<{ patch: Patch } | { ignore: string }> {
  const codeMismatch =
    !!p.subscriptionCode && !!sub.paystackSubscriptionCode && p.subscriptionCode !== sub.paystackSubscriptionCode;

  switch (p.event) {
    case "subscription.create": {
      if (!p.subscriptionCode) return { ignore: "subscription.create without subscription_code" };
      // A disabled subscription is dead: a replayed create must not revive it.
      if (sub.status === "cancelled" && sub.paystackSubscriptionCode === p.subscriptionCode) {
        return { ignore: "subscription already disabled" };
      }
      const planId = await planIdFor(db, p);
      return {
        patch: {
          status: "active",
          paystackSubscriptionCode: p.subscriptionCode,
          ...(p.emailToken ? { paystackEmailToken: p.emailToken } : {}),
          ...(p.customerCode ? { paystackCustomerCode: p.customerCode } : {}),
          ...(planId ? { planId } : {}),
          currentPeriodEnd: laterOf(sub.currentPeriodEnd, p.nextPaymentDate),
        },
      };
    }
    case "charge.success": {
      // Only subscription charges move billing state.
      const planId = await planIdFor(db, p);
      if (!planId && !p.subscriptionCode) return { ignore: "charge without plan/subscription context" };
      if (codeMismatch) return { ignore: "charge for a different subscription" };
      const periodEnd = p.nextPaymentDate ?? (p.paidAt ? addOneMonth(p.paidAt) : null);
      if (
        sub.status === "cancelled" &&
        (!periodEnd || (sub.currentPeriodEnd && periodEnd.getTime() <= sub.currentPeriodEnd.getTime()))
      ) {
        return { ignore: "stale charge for a cancelled subscription" };
      }
      return {
        patch: {
          status: "active",
          ...(planId ? { planId } : {}),
          ...(p.customerCode ? { paystackCustomerCode: p.customerCode } : {}),
          currentPeriodEnd: laterOf(sub.currentPeriodEnd, periodEnd),
        },
      };
    }
    case "invoice.payment_failed": {
      if (codeMismatch) return { ignore: "invoice for a different subscription" };
      if (sub.status === "cancelled") return { ignore: "subscription already cancelled" };
      return { patch: { status: "past_due" } };
    }
    case "subscription.disable": {
      if (codeMismatch) return { ignore: "disable for a different subscription" };
      return { patch: { status: "cancelled" } };
    }
    default:
      return { ignore: `unhandled event ${p.event}` };
  }
}

/**
 * Apply a verified Paystack event. Replay-safe: the same event twice yields
 * the same row; the second call reports `unchanged` and writes nothing.
 */
export async function applyWebhookEvent(db: DbOrTx, event: PaystackEvent): Promise<WebhookOutcome> {
  const p = parseEvent(event);
  const known = ["subscription.create", "charge.success", "invoice.payment_failed", "subscription.disable"];
  if (!known.includes(p.event)) {
    console.log(`[billing] ignoring Paystack event ${p.event}`);
    return { event: p.event, outcome: "ignored", orgId: null, note: "unhandled event" };
  }

  const sub = await resolveSubscription(db, p);
  if (!sub) {
    console.warn(`[billing] Paystack ${p.event}: no matching organisation`);
    return { event: p.event, outcome: "ignored", orgId: null, note: "no matching organisation" };
  }

  const decision = await planTransition(db, sub, p);
  if ("ignore" in decision) {
    console.log(`[billing] Paystack ${p.event} for org ${sub.organisationId} ignored: ${decision.ignore}`);
    return { event: p.event, outcome: "ignored", orgId: sub.organisationId, status: sub.status, note: decision.ignore };
  }

  const changed = (Object.keys(decision.patch) as (keyof Patch)[]).filter(
    (k) => !sameValue(decision.patch[k], sub[k]),
  );
  if (changed.length === 0) {
    return { event: p.event, outcome: "unchanged", orgId: sub.organisationId, status: sub.status };
  }

  const after = await inTx(db, async (tx) => {
    const [row] = await tx
      .update(subscriptions)
      .set({ ...decision.patch, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    // System actor: no user. writeAudit needs a user id, so insert directly.
    await tx.insert(auditLog).values({
      organisationId: sub.organisationId,
      userId: null,
      action: "update",
      tableName: "subscriptions",
      recordId: sub.id,
      before: { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, planId: sub.planId },
      after: { status: row.status, currentPeriodEnd: row.currentPeriodEnd, planId: row.planId, source: `paystack:${p.event}` },
    });
    return row;
  });
  return { event: p.event, outcome: "applied", orgId: sub.organisationId, status: after.status };
}

// ── demo loop (mock driver) ──────────────────────────────────────────────────

/**
 * Synthetic subscription.create + charge.success pair for the mock checkout
 * page — shaped like Paystack's payloads so it exercises the real webhook path.
 * Deterministic given its inputs, so a double click replays identically.
 */
export function buildMockCheckoutEvents(input: {
  orgId: string;
  planCode: string;
  reference: string;
  email: string;
  paidAt: Date;
}): PaystackEvent[] {
  const suffix = input.reference.replace(/[^A-Za-z0-9]/g, "").slice(-12).toUpperCase();
  const customer = { email: input.email, customer_code: `CUS_MOCK_${input.orgId.slice(0, 8)}` };
  const nextPayment = addOneMonth(input.paidAt).toISOString();
  return [
    {
      event: "subscription.create",
      data: {
        subscription_code: `SUB_MOCK_${suffix}`,
        email_token: `TOKEN_MOCK_${suffix}`,
        status: "active",
        next_payment_date: nextPayment,
        plan: { plan_code: input.planCode },
        customer,
        metadata: { org_id: input.orgId },
      },
    },
    {
      event: "charge.success",
      data: {
        reference: input.reference,
        status: "success",
        paid_at: input.paidAt.toISOString(),
        plan: { plan_code: input.planCode },
        customer,
        metadata: { org_id: input.orgId },
      },
    },
  ];
}
