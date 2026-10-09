import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { auditLog, notifications, plans, subscriptions } from "@/db/schema";
import { createMockPayments, MOCK_SIGNATURE } from "@/adapters/payments/mock";
import { createPaystackPayments } from "@/adapters/payments/paystack";
import type { PaymentsAdapter, PaystackEvent } from "@/adapters/payments";
import type { OrgContext } from "@/lib/authz/context";
import { isMutating } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import {
  applyWebhookEvent,
  buildMockCheckoutEvents,
  cancelSubscription,
  deriveBillingStatus,
  getBillingState,
  startCheckout,
} from "@/lib/services/billing";
import { createSupplier, listSuppliers } from "@/lib/services/suppliers";
import { createTestOrg, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { supplierInput, supplierListInput } from "@/lib/validation/buying";

import { runBillingSweep } from "../../worker/jobs/billing";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const DAY = 24 * 60 * 60 * 1000;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

async function setSub(orgId: string, patch: Partial<typeof subscriptions.$inferInsert>) {
  await db.update(subscriptions).set(patch).where(eq(subscriptions.organisationId, orgId));
}

async function subRow(orgId: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, orgId));
  return row;
}

async function auditCount(orgId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.organisationId, orgId), eq(auditLog.tableName, "subscriptions")));
  return r.n;
}

/** Mock adapter with spies, so tests can count Paystack calls. */
function spyAdapter() {
  const base = createMockPayments();
  const adapter: PaymentsAdapter = {
    createPlan: vi.fn(base.createPlan),
    initializeSubscription: vi.fn(base.initializeSubscription),
    verifyWebhook: base.verifyWebhook,
    cancelSubscription: vi.fn(base.cancelSubscription),
  };
  return adapter;
}

async function planCodeFor(planId: string) {
  await db.update(plans).set({ paystackPlanCode: `PLN_TEST_${planId.slice(0, 8)}` }).where(eq(plans.id, planId));
  return `PLN_TEST_${planId.slice(0, 8)}`;
}

function ev(event: string, data: Record<string, unknown>): PaystackEvent {
  return { event, data };
}

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  A = await createTestOrg(db);
});

afterAll(async () => {
  await t.close();
});

describe("getBillingState / read-only reasons", () => {
  it("fresh trial is writable with days left", async () => {
    const s = await getBillingState(asDb(db), A.ctx);
    expect(s.subscription?.status).toBe("trialing");
    expect(s.readOnly).toBe(false);
    expect(s.reason).toBeNull();
    expect(s.trialDaysLeft).toBe(14);
    expect(s.plan?.id).toBe(A.planId);
  });

  it("expired trial → read-only (trial_expired), 0 days left", async () => {
    await setSub(A.orgId, { trialEndsAt: new Date(Date.now() - DAY) });
    const s = await getBillingState(asDb(db), A.ctx);
    expect(s).toMatchObject({ readOnly: true, reason: "trial_expired", trialDaysLeft: 0 });
  });

  it("past_due → read-only (past_due)", async () => {
    await setSub(A.orgId, { status: "past_due" });
    expect(await getBillingState(asDb(db), A.ctx)).toMatchObject({ readOnly: true, reason: "past_due", trialDaysLeft: null });
  });

  it("cancelled → read-only (cancelled)", async () => {
    await setSub(A.orgId, { status: "cancelled" });
    expect(await getBillingState(asDb(db), A.ctx)).toMatchObject({ readOnly: true, reason: "cancelled" });
  });

  it("active (even with a past trial end) → writable", async () => {
    await setSub(A.orgId, { status: "active", trialEndsAt: new Date(Date.now() - 30 * DAY) });
    expect(await getBillingState(asDb(db), A.ctx)).toMatchObject({ readOnly: false, reason: null, trialDaysLeft: null });
  });

  it("expired-trial org: mutations rejected READ_ONLY, reads still work", async () => {
    await setSub(A.orgId, { trialEndsAt: new Date(Date.now() - DAY) });
    const sub = await subRow(A.orgId);
    const { readOnly } = deriveBillingStatus(sub);
    const ctx: OrgContext = { ...A.ctx, readOnly };
    expect(readOnly).toBe(true);
    // The guard rejects mutating permissions when readOnly; reads pass.
    expect(isMutating("supplier.write")).toBe(true);
    expect(isMutating("supplier.read")).toBe(false);
    await expectCode(createSupplier(asDb(db), ctx, supplierInput.parse({ type: "farmer", name: "Blocked" })), "READ_ONLY");
    const list = await listSuppliers(asDb(db), ctx, supplierListInput.parse({}));
    expect(list.total).toBe(0);
  });
});

describe("signature verification", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "r1" } });

  it("mock driver: only the mock signature verifies", () => {
    const m = createMockPayments();
    expect(m.verifyWebhook(body, "bad")).toBeNull();
    expect(m.verifyWebhook(body, null)).toBeNull();
    expect(m.verifyWebhook(body, MOCK_SIGNATURE)).toEqual({ event: "charge.success", data: { reference: "r1" } });
    expect(m.verifyWebhook("not json", MOCK_SIGNATURE)).toBeNull();
  });

  it("paystack driver: HMAC-SHA512 of the raw body with the secret key", () => {
    const prev = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "sk_test_billing_suite";
    try {
      const p = createPaystackPayments();
      const sig = crypto.createHmac("sha512", "sk_test_billing_suite").update(body).digest("hex");
      expect(p.verifyWebhook(body, sig)?.event).toBe("charge.success");
      expect(p.verifyWebhook(body, "bad")).toBeNull();
      expect(p.verifyWebhook(body, null)).toBeNull();
      expect(p.verifyWebhook(`${body} `, sig)).toBeNull(); // tampered body
      const wrongKey = crypto.createHmac("sha512", "sk_other").update(body).digest("hex");
      expect(p.verifyWebhook(body, wrongKey)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = prev;
    }
  });
});

describe("startCheckout", () => {
  it("creates + persists the Paystack plan code once, returns the mock checkout url", async () => {
    const adapter = spyAdapter();
    const r1 = await startCheckout(asDb(db), A.ctx, { planId: A.planId }, adapter);
    expect(r1.checkoutUrl).toMatch(/^\/settings\/billing\/mock-checkout\?ref=MOCK_.+&plan=PLN_MOCK_/);
    const [plan] = await db.select().from(plans).where(eq(plans.id, A.planId));
    expect(plan.paystackPlanCode).toMatch(/^PLN_MOCK_/);

    await startCheckout(asDb(db), A.ctx, { planId: A.planId }, adapter);
    expect(adapter.createPlan).toHaveBeenCalledTimes(1);
    expect(adapter.initializeSubscription).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.initializeSubscription).mock.calls[0][0]).toMatchObject({
      planCode: plan.paystackPlanCode,
      amountKobo: 5_000_000,
      metadata: { org_id: A.orgId, plan_id: A.planId },
    });
  });

  it("is allowed while read-only (paying is the way out)", async () => {
    await setSub(A.orgId, { trialEndsAt: new Date(Date.now() - DAY) });
    const ctx = { ...A.ctx, readOnly: true };
    await expect(startCheckout(asDb(db), ctx, { planId: A.planId }, spyAdapter())).resolves.toHaveProperty("checkoutUrl");
  });

  it("rejects non-owners, unknown plans and already-active orgs", async () => {
    const adapter = spyAdapter();
    await expectCode(startCheckout(asDb(db), { ...A.ctx, role: "manager" }, { planId: A.planId }, adapter), "FORBIDDEN");
    await expectCode(startCheckout(asDb(db), A.ctx, { planId: crypto.randomUUID() }, adapter), "NOT_FOUND");
    await setSub(A.orgId, { status: "active" });
    await expectCode(startCheckout(asDb(db), A.ctx, { planId: A.planId }, adapter), "ALREADY_ACTIVE");
  });
});

describe("applyWebhookEvent — semantically idempotent transitions", () => {
  async function mockEvents(orgId = A.orgId, paidAt = new Date("2026-10-01T10:00:00Z")) {
    const planCode = await planCodeFor(A.planId);
    const [create, charge] = buildMockCheckoutEvents({
      orgId,
      planCode,
      reference: "MOCK_ref_0001",
      email: "owner@test.local",
      paidAt,
    });
    return { create, charge, planCode };
  }

  it("subscription.create → active with code/token/period; replay leaves state + audit unchanged", async () => {
    const { create } = await mockEvents();
    const r1 = await applyWebhookEvent(asDb(db), create);
    expect(r1).toMatchObject({ outcome: "applied", orgId: A.orgId, status: "active" });
    const after1 = await subRow(A.orgId);
    expect(after1.status).toBe("active");
    expect(after1.paystackSubscriptionCode).toMatch(/^SUB_MOCK_/);
    expect(after1.paystackEmailToken).toMatch(/^TOKEN_MOCK_/);
    expect(after1.paystackCustomerCode).toMatch(/^CUS_MOCK_/);
    expect(after1.currentPeriodEnd?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    const audits = await auditCount(A.orgId);
    expect(audits).toBe(1);

    const r2 = await applyWebhookEvent(asDb(db), create);
    expect(r2.outcome).toBe("unchanged");
    expect(await subRow(A.orgId)).toEqual(after1);
    expect(await auditCount(A.orgId)).toBe(audits);
  });

  it("charge.success alone activates and rolls the period end; replay unchanged", async () => {
    const { charge } = await mockEvents();
    expect((await applyWebhookEvent(asDb(db), charge)).outcome).toBe("applied");
    const s1 = await subRow(A.orgId);
    expect(s1.status).toBe("active");
    expect(s1.currentPeriodEnd?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect((await applyWebhookEvent(asDb(db), charge)).outcome).toBe("unchanged");
    expect(await subRow(A.orgId)).toEqual(s1);

    // Renewal: later charge rolls forward; the older one replayed does not roll back.
    const { charge: renewal } = await mockEvents(A.orgId, new Date("2026-11-01T10:05:00Z"));
    await applyWebhookEvent(asDb(db), renewal);
    expect((await subRow(A.orgId)).currentPeriodEnd?.toISOString()).toBe("2026-12-01T10:05:00.000Z");
    expect((await applyWebhookEvent(asDb(db), charge)).outcome).toBe("unchanged");
    expect((await subRow(A.orgId)).currentPeriodEnd?.toISOString()).toBe("2026-12-01T10:05:00.000Z");
  });

  it("charge without plan/subscription context is ignored", async () => {
    const r = await applyWebhookEvent(asDb(db), ev("charge.success", { reference: "x", metadata: { org_id: A.orgId } }));
    expect(r.outcome).toBe("ignored");
    expect((await subRow(A.orgId)).status).toBe("trialing");
  });

  it("invoice.payment_failed → past_due (replay-safe), then a successful charge → active", async () => {
    const { create, charge } = await mockEvents();
    await applyWebhookEvent(asDb(db), create);
    const code = (await subRow(A.orgId)).paystackSubscriptionCode;
    const failed = ev("invoice.payment_failed", { subscription: { subscription_code: code }, customer: { email: "x@y.z" } });
    expect((await applyWebhookEvent(asDb(db), failed)).outcome).toBe("applied");
    const s1 = await subRow(A.orgId);
    expect(s1.status).toBe("past_due");
    expect(deriveBillingStatus(s1).reason).toBe("past_due");
    expect((await applyWebhookEvent(asDb(db), failed)).outcome).toBe("unchanged");
    expect(await subRow(A.orgId)).toEqual(s1);

    expect((await applyWebhookEvent(asDb(db), charge)).outcome).toBe("applied");
    expect((await subRow(A.orgId)).status).toBe("active");
  });

  it("subscription.disable → cancelled; replays of disable/create do not revive it", async () => {
    const { create } = await mockEvents();
    await applyWebhookEvent(asDb(db), create);
    const code = (await subRow(A.orgId)).paystackSubscriptionCode;
    const disable = ev("subscription.disable", { subscription_code: code, status: "complete" });
    expect((await applyWebhookEvent(asDb(db), disable)).outcome).toBe("applied");
    const s1 = await subRow(A.orgId);
    expect(s1.status).toBe("cancelled");
    expect((await applyWebhookEvent(asDb(db), disable)).outcome).toBe("unchanged");
    expect((await applyWebhookEvent(asDb(db), create)).outcome).toBe("ignored");
    expect(await subRow(A.orgId)).toEqual(s1);
  });

  it("events for another subscription code are ignored", async () => {
    const { create } = await mockEvents();
    await applyWebhookEvent(asDb(db), create);
    const r = await applyWebhookEvent(asDb(db), ev("subscription.disable", { subscription_code: "SUB_OTHER", metadata: { org_id: A.orgId } }));
    expect(r.outcome).toBe("ignored");
    expect((await subRow(A.orgId)).status).toBe("active");
  });

  it("unknown events and unmatched orgs are ignored", async () => {
    expect((await applyWebhookEvent(asDb(db), ev("invoice.create", {}))).outcome).toBe("ignored");
    expect((await applyWebhookEvent(asDb(db), ev("subscription.create", { subscription_code: "SUB_X", customer: { email: "nobody@nowhere" } }))).outcome).toBe("ignored");
    expect((await subRow(A.orgId)).status).toBe("trialing");
  });

  it("resolves the org by owner email when metadata is absent, and never touches another org", async () => {
    const B = await createTestOrg(db);
    const planCode = await planCodeFor(A.planId);
    const [aUser] = await db.execute(sql`select email from "user" where id = ${A.userId}`).then((r) => r.rows as { email: string }[]);
    const r = await applyWebhookEvent(
      asDb(db),
      ev("subscription.create", {
        subscription_code: "SUB_EMAIL_1",
        email_token: "tok_1",
        plan: { plan_code: planCode },
        customer: { email: aUser.email, customer_code: "CUS_EMAIL_1" },
      }),
    );
    expect(r).toMatchObject({ outcome: "applied", orgId: A.orgId });
    expect((await subRow(A.orgId)).status).toBe("active");
    expect((await subRow(B.orgId)).status).toBe("trialing");

    // A later event carrying only the customer code still finds org A.
    const failed = await applyWebhookEvent(asDb(db), ev("invoice.payment_failed", { customer: { customer_code: "CUS_EMAIL_1" } }));
    expect(failed).toMatchObject({ outcome: "applied", orgId: A.orgId });
    expect((await subRow(B.orgId)).status).toBe("trialing");
  });

  it("cancelSubscription disables via the adapter and sets cancelled (idempotent with the webhook)", async () => {
    const { create } = await mockEvents();
    await applyWebhookEvent(asDb(db), create);
    const before = await subRow(A.orgId);
    const adapter = spyAdapter();
    await expect(cancelSubscription(asDb(db), A.ctx, adapter)).resolves.toEqual({ status: "cancelled" });
    expect(adapter.cancelSubscription).toHaveBeenCalledWith({
      subscriptionCode: before.paystackSubscriptionCode,
      emailToken: before.paystackEmailToken,
    });
    expect((await subRow(A.orgId)).status).toBe("cancelled");
    const r = await applyWebhookEvent(asDb(db), ev("subscription.disable", { subscription_code: before.paystackSubscriptionCode }));
    expect(r.outcome).toBe("unchanged");
    await expect(cancelSubscription(asDb(db), A.ctx, adapter)).resolves.toEqual({ status: "cancelled" });
    expect(adapter.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("cancelSubscription without a paid subscription is refused", async () => {
    await expectCode(cancelSubscription(asDb(db), A.ctx, spyAdapter()), "NO_PAID_SUBSCRIPTION");
  });
});

describe("billing.sweep", () => {
  async function ownerNotifications(orgId: string) {
    return db.select().from(notifications).where(eq(notifications.organisationId, orgId));
  }

  it("notifies owners of expired trials and past-due orgs once (dedupe while unread)", async () => {
    const pastDue = await createTestOrg(db);
    const active = await createTestOrg(db);
    await setSub(A.orgId, { trialEndsAt: new Date(Date.now() - DAY) });
    await setSub(pastDue.orgId, { status: "past_due" });
    await setSub(active.orgId, { status: "active" });

    const r1 = await runBillingSweep(asDb(db));
    expect(r1).toEqual({ expiredTrials: 1, pastDue: 1, notifications: 2 });
    const a = await ownerNotifications(A.orgId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ userId: A.userId, type: "system", link: "/settings/billing?reason=trial_expired" });
    expect(await ownerNotifications(pastDue.orgId)).toHaveLength(1);
    expect(await ownerNotifications(active.orgId)).toHaveLength(0);
    // Status untouched — read-only is derived, not stored.
    expect((await subRow(A.orgId)).status).toBe("trialing");

    const r2 = await runBillingSweep(asDb(db));
    expect(r2.notifications).toBe(0);
    expect(await ownerNotifications(A.orgId)).toHaveLength(1);

    // Once read, the next sweep reminds again.
    await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.organisationId, A.orgId));
    const r3 = await runBillingSweep(asDb(db));
    expect(r3.notifications).toBe(1); // A re-notified; past-due reminder still unread
  });
});
