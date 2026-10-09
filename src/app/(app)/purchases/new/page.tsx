import Link from "next/link";

import { requireOrgContext, spUuid, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import * as md from "@/lib/services/masterData";
import { listSupplierOptions } from "@/lib/services/suppliers";

import { PurchaseForm } from "./_components/purchase-form";

export const metadata = { title: "New purchase · AggreTrack" };

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "purchase.create")) {
    return (
      <div>
        <PageHeader title="New purchase" />
        <NoAccess what="purchase entry" />
      </div>
    );
  }
  const params = await searchParams;

  const [suppliers, buyingPoints, commodities, grades, bagTypes] = await Promise.all([
    can(ctx.role, "supplier.read") ? listSupplierOptions(db, ctx) : Promise.resolve([]),
    md.listBuyingPoints(db, ctx),
    md.listCommodities(db, ctx),
    md.listGrades(db, ctx),
    md.listBagTypes(db, ctx),
  ]);

  if (commodities.length === 0) {
    return (
      <div>
        <PageHeader title="New purchase" />
        <EmptyState
          title="Set up your produce first"
          description="Add at least one commodity with a grade before recording purchases."
          action={
            can(ctx.role, "master-data.write") ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/settings/master-data">Open master data</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const initialSupplierId = spUuid(params, "supplierId");

  return (
    <div>
      <PageHeader title="New purchase" description="Pick the supplier, add what you bought, save." />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      <PurchaseForm
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, village: s.village }))}
        buyingPoints={buyingPoints.map((b) => ({ id: b.id, name: b.name }))}
        buyingPointRequired={ctx.restrictions.buyingPointIds !== null}
        commodities={commodities.map((c) => ({ id: c.id, name: c.name }))}
        grades={grades.map((g) => ({ id: g.id, name: g.name, commodityId: g.commodityId }))}
        bagTypes={bagTypes.map((b) => ({ id: b.id, name: b.name, standardKg: b.standardKg, sackWeightKg: b.sackWeightKg }))}
        canCreateSupplier={can(ctx.role, "supplier.write") && !ctx.readOnly}
        initialSupplierId={
          initialSupplierId && suppliers.some((s) => s.id === initialSupplierId) ? initialSupplierId : undefined
        }
      />
    </div>
  );
}
