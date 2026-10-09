import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { koboToNairaInput } from "@/components/buying/format";
import { orNotFound, requireOrgContext, uuidParamOr404 } from "@/components/buying/server";
import { NoAccess, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import * as md from "@/lib/services/masterData";
import { getPurchaseDetail } from "@/lib/services/purchases";
import { listSupplierOptions } from "@/lib/services/suppliers";

import { PurchaseForm } from "../../new/_components/purchase-form";
import type { PurchaseFormValues } from "../../new/_components/purchase-schema";

export const metadata = { title: "Edit purchase · AggreTrack" };

export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "purchase.create")) {
    return (
      <div>
        <PageHeader title="Edit purchase" />
        <NoAccess what="purchase entry" />
      </div>
    );
  }
  const id = uuidParamOr404((await params).id);
  const p = await orNotFound(getPurchaseDetail(db, ctx, id));
  const back = (
    <Link href={`/purchases/${p.id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
      <ArrowLeft className="size-4" /> {p.purchaseNumber ?? "Purchase"}
    </Link>
  );

  if (p.status !== "draft" && p.status !== "pending_approval") {
    return (
      <div>
        {back}
        <PageHeader title="Edit purchase" />
        <p className="rounded-lg border px-4 py-6 text-sm text-muted-foreground">
          Only draft purchases or purchases waiting for approval can be edited.
        </p>
      </div>
    );
  }

  const [suppliers, buyingPoints, commodities, grades, bagTypes] = await Promise.all([
    can(ctx.role, "supplier.read")
      ? listSupplierOptions(db, ctx)
      : Promise.resolve([{ id: p.supplierId, name: p.supplierName, phone: p.supplierPhone, village: null, type: "farmer" as const }]),
    md.listBuyingPoints(db, ctx),
    md.listCommodities(db, ctx, { includeInactive: true }),
    md.listGrades(db, ctx),
    md.listBagTypes(db, ctx),
  ]);

  const values: PurchaseFormValues = {
    supplierId: p.supplierId,
    buyingPointId: p.buyingPointId ?? "",
    purchaseDate: p.purchaseDate,
    lines: p.lines.map((l) => ({
      id: l.id,
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      bagTypeId: l.bagTypeId ?? "",
      bags: l.bags > 0 ? String(l.bags) : "",
      grossKg: l.grossKg.replace(/\.?0+$/, ""),
      moisturePercent: l.moisturePercent ? l.moisturePercent.replace(/\.?0+$/, "") : "",
      priceNaira: koboToNairaInput(l.pricePerKgKobo),
      // Auto sack-weight rows are recomputed from bags × sack weight on save.
      deductions: l.deductions
        .filter((d) => !(d.reason === "sack_weight" && d.note?.startsWith("auto")))
        .map((d) => ({ reason: d.reason, kg: d.kg.replace(/\.?0+$/, "") })),
    })),
  };

  return (
    <div>
      {back}
      <PageHeader title={`Edit ${p.purchaseNumber ?? "purchase"}`} description="Saving replaces the lines and re-checks the price guide." />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      {p.rejectedReason ? (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Sent back: {p.rejectedReason}
        </p>
      ) : null}
      <PurchaseForm
        existing={{ id: p.id, values }}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, village: s.village }))}
        buyingPoints={buyingPoints.map((b) => ({ id: b.id, name: b.name }))}
        buyingPointRequired={ctx.restrictions.buyingPointIds !== null}
        commodities={commodities.map((c) => ({ id: c.id, name: c.name }))}
        grades={grades.map((g) => ({ id: g.id, name: g.name, commodityId: g.commodityId }))}
        bagTypes={bagTypes.map((b) => ({ id: b.id, name: b.name, standardKg: b.standardKg, sackWeightKg: b.sackWeightKg }))}
        canCreateSupplier={can(ctx.role, "supplier.write") && !ctx.readOnly}
      />
    </div>
  );
}
