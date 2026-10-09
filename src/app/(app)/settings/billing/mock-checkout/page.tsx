import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { plans, user } from "@/db/schema";
import { MOCK_SIGNATURE } from "@/adapters/payments/mock";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { formatNaira } from "@/lib/domain/units";
import { buildMockCheckoutEvents } from "@/lib/services/billing";
import { mockCheckoutQuery } from "@/lib/validation/billing";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { SimulatePayment } from "./_components/SimulatePayment";

export const metadata: Metadata = { title: "Test checkout" };

/**
 * Demo loop for the mock payments driver: stands in for Paystack's hosted
 * checkout. Only exists when APP_ENV is development/demo AND the mock driver
 * is active — never in production.
 */
function mockCheckoutEnabled(): boolean {
  const appEnv = process.env.APP_ENV ?? "development";
  const driver = process.env.PAYMENTS_DRIVER ?? "mock";
  return (appEnv === "development" || appEnv === "demo") && driver === "mock";
}

export default async function MockCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; plan?: string }>;
}) {
  if (!mockCheckoutEnabled()) notFound();
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "billing.manage")) redirect("/settings/billing");

  const parsed = mockCheckoutQuery.safeParse(await searchParams);
  if (!parsed.success) {
    return (
      <div>
        <PageHeader title="Test checkout" />
        <Alert variant="destructive">
          <AlertTitle>Invalid checkout link</AlertTitle>
          <AlertDescription>Start again from the billing page.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const [plan] = await db
    .select({ name: plans.name, price: plans.monthlyPriceKobo })
    .from(plans)
    .where(eq(plans.paystackPlanCode, parsed.data.plan))
    .limit(1);
  const [viewer] = await db.select({ email: user.email }).from(user).where(eq(user.id, ctx.userId)).limit(1);

  const events = buildMockCheckoutEvents({
    orgId: ctx.orgId,
    planCode: parsed.data.plan,
    reference: parsed.data.ref,
    email: viewer?.email ?? "owner@example.com",
    paidAt: new Date(),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Test checkout" description="Mock payments driver — no real money moves." />
      <Card>
        <CardHeader>
          <CardTitle>{plan?.name ?? "Subscription"}</CardTitle>
          <CardDescription>
            {plan ? `${formatNaira(plan.price)} / month` : parsed.data.plan} · reference {parsed.data.ref}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This page stands in for Paystack&apos;s hosted checkout. Simulating a payment sends the same
            webhook events Paystack would (subscription.create, then charge.success) to this app.
          </p>
          <SimulatePayment bodies={events.map((e) => JSON.stringify(e))} signature={MOCK_SIGNATURE} />
        </CardContent>
      </Card>
    </div>
  );
}
