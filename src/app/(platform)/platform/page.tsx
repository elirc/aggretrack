import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { getHealthOverview, SUBSCRIPTION_STATUSES } from "@/lib/services/platform";

import { requirePlatformAdmin, StatusBadge } from "./_components/shared";

export const metadata = { title: "Platform health · AggreTrack" };

export default async function PlatformHealthPage() {
  await requirePlatformAdmin();
  const h = await getHealthOverview(db);

  const tiles = [
    { label: "Organisations", value: h.organisations, href: "/platform/organisations" },
    { label: "Users", value: h.users },
    { label: "Memberships", value: h.memberships },
    { label: "Platform admins", value: h.platformAdmins },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Platform health" description="Usage across all organisations." />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="text-2xl font-semibold tabular-nums">
                {t.href ? <Link href={t.href}>{t.value}</Link> : t.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Subscriptions by status</CardTitle>
          <CardDescription>
            Read-only applies to past due, cancelled and expired trials ({h.expiredTrials} expired trial
            {h.expiredTrials === 1 ? "" : "s"}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {SUBSCRIPTION_STATUSES.map((s) => (
              <li key={s} className="flex items-center justify-between rounded-md border px-3 py-2">
                <StatusBadge status={s} />
                <span className="font-semibold tabular-nums">{h.subscriptionsByStatus[s]}</span>
              </li>
            ))}
          </ul>
          {h.orgsWithoutSubscription > 0 ? (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
              {h.orgsWithoutSubscription} organisation(s) have no subscription row.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
