import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { DomainError } from "@/lib/domain/errors";
import { getOrganisation, type OrgDetail } from "@/lib/services/platform";

import { ReadOnlyToggle } from "../../_components/read-only-toggle";
import { fmtDate, fmtDateTime, requirePlatformAdmin, StatusBadge } from "../../_components/shared";

export const metadata = { title: "Organisation · Platform" };

export default async function OrganisationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin();
  const { id } = await params;

  let org: OrgDetail;
  try {
    org = await getOrganisation(db, decodeURIComponent(id));
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const usage = [
    { label: "Members", value: org.memberCount },
    { label: "Commodities", value: org.usage.commodities },
    { label: "Warehouses", value: org.usage.warehouses },
    { label: "Suppliers", value: org.usage.suppliers },
    { label: "Purchases", value: org.usage.purchases },
    { label: "Sales orders", value: org.usage.salesOrders },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={org.name}
        description={`Created ${fmtDate(org.createdAt)}${org.slug ? ` · ${org.slug}` : ""}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/platform/audit?organisationId=${encodeURIComponent(org.id)}`}>Audit log</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Subscription <StatusBadge status={org.subscriptionStatus} />
            {org.readOnly ? <Badge variant="destructive">read only</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {org.subscription ? (
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Plan</dt>
                <dd>{org.planName ?? org.subscription.planCode ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Trial ends</dt>
                <dd>{fmtDateTime(org.subscription.trialEndsAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Current period ends</dt>
                <dd>{fmtDateTime(org.subscription.currentPeriodEnd)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No subscription row — read-only toggle unavailable.</p>
          )}
          <ReadOnlyToggle
            organisationId={org.id}
            readOnly={org.readOnly}
            disabled={!org.subscription}
          />
        </CardContent>
      </Card>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {usage.map((u) => (
          <Card key={u.label} className="py-3">
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">{u.label}</p>
              <p className="text-xl font-semibold tabular-nums">{u.value}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          {org.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members.</p>
          ) : (
            <ul className="divide-y">
              {org.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.phoneNumber ? `+${m.phoneNumber} · ` : ""}
                      {m.email}
                    </p>
                  </div>
                  <Badge variant="outline">{m.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
