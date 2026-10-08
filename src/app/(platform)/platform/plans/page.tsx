import { PageHeader } from "@/components/layout/PageHeader";
import { db } from "@/db/client";
import { listPlans } from "@/lib/services/platform";

import { PlansManager } from "../_components/plans-manager";
import { requirePlatformAdmin } from "../_components/shared";

export const metadata = { title: "Plans · Platform" };

export default async function PlansPage() {
  await requirePlatformAdmin();
  const plans = await listPlans(db);
  return (
    <div>
      <PageHeader
        title="Plans"
        description="Subscription plans offered to organisations. Deactivate instead of deleting."
      />
      <PlansManager
        plans={plans.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          monthlyPriceKobo: p.monthlyPriceKobo,
          userLimit: p.userLimit,
          paystackPlanCode: p.paystackPlanCode,
          active: p.active,
          subscriptionCount: p.subscriptionCount,
        }))}
      />
    </div>
  );
}
