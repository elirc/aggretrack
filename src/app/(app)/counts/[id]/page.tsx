import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CountActions } from "@/components/warehouse/count-actions";
import { fmtGrams, fmtKg, formatLagosDateTime } from "@/components/warehouse/format";
import { adjustmentsForCount, lotLabels, orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { NoAccess, Notice, SignedKg, Stat, StatusBadge } from "@/components/warehouse/status";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { isDomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { approvalThresholdGrams } from "@/lib/services/adjustments";
import { getCount, type StockCountWithLines } from "@/lib/services/counts";
import * as md from "@/lib/services/masterData";
import { zUuid } from "@/lib/validation/common";

export const metadata = { title: "Stock count · AggreTrack" };

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "count.read")) return <NoAccess title="Stock count" what="stock counts" />;

  const { id } = await params;
  if (!zUuid.safeParse(id).success) notFound();

  let c: StockCountWithLines;
  try {
    c = await getCount(db, ctx, id);
  } catch (err) {
    if (isDomainError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const [threshold, warehouses, lotMap, adjustments, warehouse] = await Promise.all([
    approvalThresholdGrams(db, ctx.orgId),
    orgWarehouseLabels(ctx),
    lotLabels(
      ctx,
      c.lines.map((l) => l.lotId),
    ),
    c.status === "posted" ? adjustmentsForCount(ctx, c.id) : Promise.resolve([]),
    md.getWarehouse(db, ctx, c.warehouseId).catch(() => null),
  ]);
  const whName = warehouses.find((w) => w.id === c.warehouseId)?.name ?? "Unknown warehouse";
  const binName = (bid: string | null) => (bid ? (warehouse?.bins.find((b) => b.id === bid)?.name ?? "Bin") : null);

  const lines = c.lines.map((l) => {
    const diff = kgToGrams(l.diffKg);
    return { ...l, diff, needsApproval: diff !== 0 && Math.abs(diff) > threshold };
  });
  const autoCount = lines.filter((l) => l.diff !== 0 && !l.needsApproval).length;
  const approvalCount = lines.filter((l) => l.needsApproval).length;
  const net = lines.reduce((s, l) => s + l.diff, 0);
  const gains = lines.reduce((s, l) => s + Math.max(0, l.diff), 0);
  const losses = lines.reduce((s, l) => s + Math.min(0, l.diff), 0);
  const isDraft = c.status === "draft";
  const writable = !ctx.readOnly;
  const adjByLot = new Map(adjustments.map((a) => [a.lotId, a]));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Count ${c.countNumber}`}
        description={`${whName} · counted ${formatLagosDateTime(c.countedAt)}`}
        actions={<StatusBadge status={c.status} />}
      />

      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
          <Stat label="Lots counted" value={lines.length} />
          <Stat label="Net variance" value={<SignedKg grams={net} />} />
          <Stat label="Gains" value={<SignedKg grams={gains} />} />
          <Stat label="Losses" value={<SignedKg grams={losses} />} />
        </CardContent>
      </Card>

      {isDraft ? (
        <Notice>
          Differences up to {fmtGrams(threshold)} post automatically; larger ones wait for approval.{" "}
          {approvalCount > 0 ? `${approvalCount} line${approvalCount === 1 ? "" : "s"} will need approval.` : ""}
        </Notice>
      ) : null}

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Variance review</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <ul className="flex flex-col divide-y rounded-md border">
            {lines.map((l) => {
              const lot = lotMap.get(l.lotId);
              const adj = adjByLot.get(l.lotId);
              return (
                <li key={l.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link href={`/stock/lots/${l.lotId}`} className="flex flex-col underline-offset-4 hover:underline">
                      <span className="font-mono">{lot?.lotNumber ?? l.lotId.slice(0, 8)}</span>
                      <span className="text-xs text-muted-foreground">
                        {lot ? `${lot.commodityName} ${lot.gradeName}` : ""}
                        {binName(l.binId) ? ` · ${binName(l.binId)}` : ""}
                      </span>
                    </Link>
                    {l.diff === 0 ? (
                      <span className="text-emerald-700 dark:text-emerald-400">Matches</span>
                    ) : (
                      <SignedKg grams={l.diff} />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      System {fmtKg(l.systemKg)} · counted {fmtKg(l.countedKg)}
                      {l.countedBags !== null ? ` · ${l.countedBags} bags` : ""}
                    </span>
                    {isDraft && l.diff !== 0 ? (
                      l.needsApproval ? (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                          Needs approval
                        </Badge>
                      ) : (
                        <Badge variant="outline">Auto-posts</Badge>
                      )
                    ) : null}
                    {adj ? (
                      <Link href={`/adjustments/${adj.id}`} className="inline-flex items-center gap-1.5">
                        <span className="font-mono underline-offset-4 hover:underline">{adj.adjustmentNumber}</span>
                        <StatusBadge status={adj.status} />
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {isDraft && writable ? (
        <CountActions
          countId={c.id}
          canPost={can(ctx.role, "count.post")}
          canCancel={can(ctx.role, "count.write")}
          autoCount={autoCount}
          approvalCount={approvalCount}
        />
      ) : null}
    </div>
  );
}
