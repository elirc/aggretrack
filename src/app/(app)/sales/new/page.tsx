import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState, NoAccess, ReadOnlyBanner, isUuid, sp } from "@/components/selling/page-states";
import { SalesOrderForm } from "@/components/selling/sales-order-form";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listCustomers } from "@/lib/services/customers";
import { listCommodities, listGrades } from "@/lib/services/masterData";
import { lagosToday } from "@/lib/services/salesOrders";

export const metadata = { title: "New sale · AggreTrack" };

export default async function NewSalePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "sale.write")) return <NoAccess title="New sale" what="creating sales orders" />;

  const params = await searchParams;
  const customerParam = sp(params.customerId);

  const [customers, commodities, grades] = await Promise.all([
    listCustomers(db, ctx, { pageSize: 200 }),
    listCommodities(db, ctx),
    listGrades(db, ctx),
  ]);
  const activeCommodityIds = new Set(commodities.map((c) => c.id));

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link href="/sales" className="text-sm text-muted-foreground hover:underline">
        ← Sales
      </Link>
      <PageHeader title="New sale" description="Customer, then lines by commodity, grade, kg and price." />
      <ReadOnlyBanner show={ctx.readOnly} />
      {ctx.readOnly ? null : commodities.length === 0 ? (
        <EmptyState
          title="No commodities set up yet."
          hint="Add commodities and grades in master data before selling."
          action={
            can(ctx.role, "master-data.write") ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/settings/master-data">Open master data</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SalesOrderForm
          customers={customers.rows.map((c) => ({ id: c.id, name: c.name }))}
          commodities={commodities.map((c) => ({ id: c.id, name: c.name }))}
          grades={grades
            .filter((g) => activeCommodityIds.has(g.commodityId))
            .map((g) => ({ id: g.id, name: g.name, commodityId: g.commodityId }))}
          defaultDate={lagosToday()}
          defaultCustomerId={isUuid(customerParam) ? customerParam : undefined}
          canCreateCustomer={can(ctx.role, "customer.write")}
        />
      )}
    </div>
  );
}
