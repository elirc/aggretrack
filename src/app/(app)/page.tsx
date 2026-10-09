import { Suspense } from "react";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { DashboardContent } from "@/components/shared/dashboard/DashboardContent";
import { DashboardSkeleton } from "@/components/shared/dashboard/DashboardSkeleton";
import { resolveOrgContext } from "@/lib/authz/resolve";

export const metadata = { title: "Dashboard · AggreTrack" };

/**
 * Dashboard. The header paints immediately; the aggregate body streams in
 * behind a Suspense skeleton (no (app)/loading.tsx — that would wrap every
 * route in the group).
 */
export default async function DashboardPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  return (
    <div>
      <PageHeader title="Dashboard" description="Your operations at a glance" />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent ctx={ctx} />
      </Suspense>
    </div>
  );
}
