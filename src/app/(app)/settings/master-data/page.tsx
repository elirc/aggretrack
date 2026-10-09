import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import * as md from "@/lib/services/masterData";

import { MasterDataTabs } from "./_components/master-data-tabs";
import { MASTER_DATA_TABS, type MasterDataTab } from "./_components/tabs-meta";

export const metadata = { title: "Master data · AggreTrack" };

export default async function MasterDataPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  if (!can(ctx.role, "master-data.read")) {
    return (
      <div>
        <PageHeader title="Master data" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to master data.</p>
      </div>
    );
  }

  const { tab } = await searchParams;
  const initialTab: MasterDataTab = MASTER_DATA_TABS.some((t) => t.value === tab)
    ? (tab as MasterDataTab)
    : "commodities";

  const [commodities, grades, bagTypes, warehouses, buyingPoints, vehicles, drivers, expenseCategories] =
    await Promise.all([
      md.listCommodities(db, ctx, { includeInactive: true }),
      md.listGrades(db, ctx),
      md.listBagTypes(db, ctx),
      md.listWarehouses(db, ctx, { includeInactive: true }),
      md.listBuyingPoints(db, ctx, { includeInactive: true }),
      md.listVehicles(db, ctx),
      md.listDrivers(db, ctx),
      md.listExpenseCategories(db, ctx),
    ]);

  const canWrite = can(ctx.role, "master-data.write") && !ctx.readOnly;

  return (
    <div>
      <PageHeader
        title="Master data"
        description="Commodities, grades, bags, warehouses, buying points, transport and cost categories."
        actions={
          canWrite ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/onboarding">Setup wizard</Link>
            </Button>
          ) : null
        }
      />
      {ctx.readOnly ? (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Subscription inactive — master data is read only.
        </p>
      ) : null}
      <MasterDataTabs
        commodities={commodities}
        grades={grades}
        bagTypes={bagTypes}
        warehouses={warehouses}
        buyingPoints={buyingPoints}
        vehicles={vehicles}
        drivers={drivers}
        expenseCategories={expenseCategories}
        canWrite={canWrite}
        initialTab={initialTab}
      />
    </div>
  );
}
