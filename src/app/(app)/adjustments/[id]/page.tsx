import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { AdjustmentDecision } from "@/components/warehouse/adjustment-decision";
import { ADJUSTMENT_REASON_LABEL, fmtBags, formatLagosDateTime } from "@/components/warehouse/format";
import { lotLabels, orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { NoAccess, Notice, SignedKg, Stat, StatusBadge } from "@/components/warehouse/status";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { isDomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { getAdjustment, type Adjustment } from "@/lib/services/adjustments";
import { zUuid } from "@/lib/validation/common";

export const metadata = { title: "Adjustment · AggreTrack" };

export default async function AdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "adjustment.read")) return <NoAccess title="Adjustment" what="adjustments" />;

  const { id } = await params;
  if (!zUuid.safeParse(id).success) notFound();

  let a: Adjustment;
  try {
    a = await getAdjustment(db, ctx, id);
  } catch (err) {
    if (isDomainError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const [lotMap, warehouses] = await Promise.all([lotLabels(ctx, [a.lotId]), orgWarehouseLabels(ctx)]);
  const lot = lotMap.get(a.lotId);
  const whName = warehouses.find((w) => w.id === a.warehouseId)?.name ?? "Unknown warehouse";
  const canApprove = a.status === "pending_approval" && can(ctx.role, "adjustment.approve") && !ctx.readOnly;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PageHeader
        title={`Adjustment ${a.adjustmentNumber}`}
        description={`${ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason} · ${whName}`}
        actions={<StatusBadge status={a.status} />}
      />
      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-2 gap-3 px-4">
          <Stat
            label="Lot"
            className="col-span-2"
            value={
              <Link href={`/stock/lots/${a.lotId}`} className="underline-offset-4 hover:underline">
                {lot ? `${lot.lotNumber} · ${lot.commodityName} ${lot.gradeName}` : a.lotId.slice(0, 8)}
              </Link>
            }
          />
          <Stat label="Change" value={<SignedKg grams={kgToGrams(a.kg)} />} />
          <Stat label="Bags" value={a.bags ? fmtBags(a.bags) : "—"} />
          <Stat label="Created" value={formatLagosDateTime(a.createdAt)} />
          {a.approvedAt ? (
            <Stat label={a.approvedBy ? "Approved" : "Auto-posted"} value={formatLagosDateTime(a.approvedAt)} />
          ) : null}
          {a.sourceCountId ? (
            <Stat
              label="Source"
              value={
                <Link href={`/counts/${a.sourceCountId}`} className="underline-offset-4 hover:underline">
                  Stock count
                </Link>
              }
            />
          ) : null}
          {a.note ? <Stat label="Note" className="col-span-2" value={a.note} /> : null}
          {a.rejectedReason ? <Stat label="Rejected because" className="col-span-2" value={a.rejectedReason} /> : null}
        </CardContent>
      </Card>
      {a.status === "pending_approval" ? (
        canApprove ? (
          <AdjustmentDecision adjustmentId={a.id} label={a.adjustmentNumber} />
        ) : (
          <Notice>Waiting for a manager or owner to approve. Stock changes only once approved.</Notice>
        )
      ) : null}
    </div>
  );
}
