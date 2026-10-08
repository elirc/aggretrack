import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import * as md from "@/lib/services/masterData";

import { OnboardingWizard } from "./_components/onboarding-wizard";

export const metadata = { title: "Set up your organisation · AggreTrack" };

const STEP_KEYS = ["commodities", "grades", "bag-types", "warehouses", "buying-points", "users"];

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  if (!can(ctx.role, "master-data.write") || !can(ctx.role, "org.settings")) {
    return (
      <div>
        <PageHeader title="Organisation setup" />
        <p className="mb-4 text-sm text-muted-foreground">
          Only an owner or manager can run the setup wizard.
        </p>
        <Button asChild className="h-11">
          <Link href="/">Go to dashboard</Link>
        </Button>
      </div>
    );
  }

  const { step } = await searchParams;
  const [commodities, grades, bagTypes, warehouses, buyingPoints, status] = await Promise.all([
    md.listCommodities(db, ctx),
    md.listGrades(db, ctx),
    md.listBagTypes(db, ctx),
    md.listWarehouses(db, ctx),
    md.listBuyingPoints(db, ctx),
    md.getSetupStatus(db, ctx),
  ]);

  const requested = step ? STEP_KEYS.indexOf(step) : -1;

  return (
    <div>
      <PageHeader
        title="Set up your organisation"
        description={
          status.setupCompletedAt
            ? "Setup is complete — add more any time."
            : "A few quick steps. Every step can be skipped and finished later."
        }
      />
      {ctx.readOnly ? (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Subscription inactive — changes are disabled.
        </p>
      ) : null}
      <OnboardingWizard
        commodities={commodities.map((c) => ({ id: c.id, name: c.name, code: c.code }))}
        grades={grades.map((g) => ({ id: g.id, name: g.name, commodityName: g.commodityName }))}
        bagTypes={bagTypes.map((b) => ({ id: b.id, name: b.name, standardKg: b.standardKg }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, capacityKg: w.capacityKg }))}
        buyingPoints={buyingPoints.map((p) => ({ id: p.id, name: p.name, state: p.state }))}
        setupCompletedAt={status.setupCompletedAt}
        initialStep={requested >= 0 ? requested : 0}
      />
    </div>
  );
}
