import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { formatLagosDate } from "@/lib/domain/format";
import { formatNaira } from "@/lib/domain/units";
import { getBillingState, listActivePlans, type ReadOnlyReason } from "@/lib/services/billing";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { CancelSubscriptionButton } from "./_components/CancelSubscriptionButton";
import { PlanPicker } from "./_components/PlanPicker";

export const metadata: Metadata = { title: "Billing" };

const STATUS_LABEL = {
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
} as const;

const REASON_TEXT: Record<Exclude<ReadOnlyReason, null>, { title: string; body: string }> = {
  trial_expired: {
    title: "Your free trial has ended",
    body: "The organisation is read-only: you can still view every record, report and document, but nothing new can be recorded until you subscribe. Nothing has been deleted.",
  },
  past_due: {
    title: "Payment overdue",
    body: "Your last subscription payment failed, so the organisation is read-only. Your data is safe. Pay again below to continue recording.",
  },
  cancelled: {
    title: "Subscription cancelled",
    body: "The organisation is read-only. All your data is kept. Subscribe again to resume recording.",
  },
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  if (!can(ctx.role, "billing.manage")) {
    return (
      <div>
        <PageHeader title="Billing" />
        <Alert>
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>Only the organisation owner can manage billing.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const sp = await searchParams;
  const [state, plans] = await Promise.all([getBillingState(db, ctx), listActivePlans(db)]);
  const sub = state.subscription;
  const canSubscribe = !!sub && sub.status !== "active";

  return (
    <div className="space-y-4">
      <PageHeader title="Billing" description="Your plan, trial and subscription." />

      {sp.checkout === "success" && sub?.status === "active" ? (
        <Alert>
          <AlertTitle>Payment received</AlertTitle>
          <AlertDescription>Your subscription is active. Thank you!</AlertDescription>
        </Alert>
      ) : null}

      {state.reason ? (
        <Alert variant="destructive">
          <AlertTitle>{REASON_TEXT[state.reason].title}</AlertTitle>
          <AlertDescription>{REASON_TEXT[state.reason].body}</AlertDescription>
        </Alert>
      ) : null}

      {!sub || !state.plan ? (
        <Alert>
          <AlertTitle>No subscription yet</AlertTitle>
          <AlertDescription>
            This organisation has no subscription record. Contact support to set one up.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {state.plan.name}
              <Badge variant={state.readOnly ? "destructive" : sub.status === "active" ? "default" : "secondary"}>
                {STATUS_LABEL[sub.status]}
              </Badge>
            </CardTitle>
            <CardDescription>
              {formatNaira(state.plan.monthlyPriceKobo)} / month · up to {state.plan.userLimit} users
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {sub.status === "trialing" ? (
              <p>
                {state.trialDaysLeft && state.trialDaysLeft > 0
                  ? `${state.trialDaysLeft} day${state.trialDaysLeft === 1 ? "" : "s"} left in your free trial`
                  : "Your free trial has ended"}{" "}
                <span className="text-muted-foreground">(ends {formatLagosDate(sub.trialEndsAt)})</span>
              </p>
            ) : null}
            {sub.currentPeriodEnd && sub.status === "active" ? (
              <p>Renews {formatLagosDate(sub.currentPeriodEnd)}</p>
            ) : null}
            {sub.currentPeriodEnd && sub.status === "cancelled" ? (
              <p className="text-muted-foreground">Last paid period ended {formatLagosDate(sub.currentPeriodEnd)}</p>
            ) : null}
            {sub.canCancel ? (
              <div className="pt-3">
                <CancelSubscriptionButton />
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {canSubscribe ? (
        plans.length === 0 ? (
          <Alert>
            <AlertTitle>No plans available</AlertTitle>
            <AlertDescription>No subscription plans are on sale right now.</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Choose a plan</CardTitle>
              <CardDescription>
                You will be taken to Paystack&apos;s secure checkout. Billing is monthly; cancel any time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PlanPicker
                plans={plans.map((p) => ({
                  id: p.id,
                  name: p.name,
                  price: formatNaira(p.monthlyPriceKobo),
                  userLimit: p.userLimit,
                }))}
                defaultPlanId={state.plan?.id ?? plans[0].id}
              />
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}
