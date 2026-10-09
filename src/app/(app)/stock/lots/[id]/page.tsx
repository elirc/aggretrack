import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MOVEMENT_TYPE_LABEL,
  fmtBags,
  fmtGrams,
  fmtKg,
  fmtNaira,
  fmtRatePerKg,
  formatLagosDate,
  formatLagosDateTime,
} from "@/components/warehouse/format";
import { NoAccess, Notice, RefDocLink, SignedKg, Stat } from "@/components/warehouse/status";
import { db } from "@/db/client";
import { lotTraceAction } from "@/actions/reports";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { isDomainError } from "@/lib/domain/errors";
import { zUuid } from "@/lib/validation/common";
import { getLotDetail, type LotDetail } from "@/lib/services/stockQueries";

export const metadata = { title: "Lot · AggreTrack" };

export default async function LotPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "stock.read")) return <NoAccess title="Lot" what="stock" />;

  const { id } = await params;
  if (!zUuid.safeParse(id).success) notFound();

  let lot: LotDetail;
  try {
    lot = await getLotDetail(db, ctx, { lotId: id });
  } catch (err) {
    if (isDomainError(err) && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }

  // Full trace (supplier origin + customers) is a report capability.
  const traceRes = can(ctx.role, "report.read") ? await lotTraceAction({ lotId: id }) : null;
  const trace = traceRes?.ok ? traceRes.data.trace : null;
  const margin = traceRes?.ok ? traceRes.data.margin : null;

  const showCost = lot.purchasePricePerKgKobo !== undefined || lot.landedCostPerKgKobo !== undefined;
  const canAdjust = can(ctx.role, "adjustment.write") && !ctx.readOnly;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Lot ${lot.lotNumber}`}
        description={`${lot.commodityName} · ${lot.gradeName} · received ${formatLagosDate(lot.receivedAt)}`}
        actions={
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link href={`/movements?lot=${lot.id}`}>Movements</Link>
          </Button>
        }
      />

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">On hand</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="On hand" value={fmtGrams(lot.onHand.grams)} />
            <Stat label="Bags" value={lot.onHand.bags.toLocaleString("en-NG")} />
            <Stat label="Original" value={`${fmtKg(lot.originalKg)} · ${fmtBags(lot.originalBags)}`} />
            {lot.onHand.valueKobo !== undefined ? <Stat label="Value" value={fmtNaira(lot.onHand.valueKobo)} /> : null}
          </div>
          {lot.byWarehouse.length > 0 ? (
            <ul className="flex flex-col divide-y rounded-md border">
              {lot.byWarehouse.map((w) => (
                <li key={w.warehouseId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{w.warehouseName}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {fmtGrams(w.grams)} · {fmtBags(w.bags)}
                    {w.valueKobo !== undefined ? ` · ${fmtNaira(w.valueKobo)}` : ""}
                    {canAdjust ? (
                      <Button asChild variant="ghost" size="sm" className="h-9">
                        <Link href={`/adjustments/new?warehouse=${w.warehouseId}&lot=${lot.id}`}>Adjust</Link>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing left on hand — this lot is fully moved out.</p>
          )}
        </CardContent>
      </Card>

      {showCost ? (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Cost</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
            {lot.purchasePricePerKgKobo !== undefined ? (
              <Stat label="Purchase price" value={fmtRatePerKg(lot.purchasePricePerKgKobo)} />
            ) : null}
            {lot.landedCostPerKgKobo !== undefined ? (
              <Stat label="Landed cost" value={fmtRatePerKg(lot.landedCostPerKgKobo)} />
            ) : null}
            {margin ? (
              <>
                <Stat label="Revenue" value={fmtNaira(margin.revenueKobo)} />
                <Stat
                  label="Margin"
                  value={`${fmtNaira(margin.marginKobo)} (${margin.marginPercent.toFixed(1)}%)`}
                />
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Origin</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 text-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Stat
              label="Supplier"
              value={
                <Link href={`/suppliers/${lot.supplierId}`} className="underline-offset-4 hover:underline">
                  {lot.supplierName}
                </Link>
              }
            />
            <Stat
              label="Purchase"
              value={
                <Link href={`/purchases/${lot.purchaseId}`} className="underline-offset-4 hover:underline">
                  {lot.purchaseNumber ?? "Purchase"}
                </Link>
              }
            />
            {trace ? (
              <>
                <Stat
                  label="Supplier details"
                  value={[trace.supplier.type, trace.supplier.village, trace.supplier.phone].filter(Boolean).join(" · ") || "—"}
                />
                <Stat
                  label="Purchase date · GRN"
                  value={`${trace.purchase.purchaseDate} · ${trace.purchase.grnNumber ?? "—"}`}
                />
                <Stat
                  label="Bought"
                  value={`${fmtKg(trace.purchaseLine.netKg)} net of ${fmtKg(trace.purchaseLine.grossKg)} gross · ${fmtBags(trace.purchaseLine.bags)}`}
                />
                {trace.purchaseLine.moisturePercent ? (
                  <Stat label="Moisture" value={`${trace.purchaseLine.moisturePercent}%`} />
                ) : null}
                {trace.purchaseLine.amountKobo !== null ? (
                  <Stat label="Line amount" value={fmtNaira(trace.purchaseLine.amountKobo)} />
                ) : null}
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {trace ? (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Where it went</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4 text-sm">
            {trace.customers.length === 0 ? (
              <p className="text-muted-foreground">Not sold to any customer yet.</p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-2">
                  {trace.customers.map((c) => (
                    <li key={c.customerId}>
                      <Link
                        href={`/customers/${c.customerId}`}
                        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 hover:bg-accent/50"
                      >
                        <span className="font-medium">{c.customerName}</span>
                        <span className="tabular-nums text-muted-foreground">{fmtKg(c.kg)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <ul className="flex flex-col divide-y rounded-md border">
                  {trace.dispatches.map((d) => (
                    <li key={d.dispatchLineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="flex flex-col">
                        <Link href={`/dispatches/${d.dispatchId}`} className="font-medium underline-offset-4 hover:underline">
                          {d.waybillNumber ?? "Dispatch"}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {formatLagosDate(d.dispatchedAt)} ·{" "}
                          <Link href={`/sales/${d.salesOrderId}`} className="underline-offset-4 hover:underline">
                            {d.orderNumber}
                          </Link>{" "}
                          · {d.customerName}
                        </span>
                      </span>
                      <span className="tabular-nums">{fmtKg(d.kg)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      ) : traceRes && !traceRes.ok ? (
        <Notice tone="warn">The customer trace couldn&apos;t be loaded right now.</Notice>
      ) : null}

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Movement timeline</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {lot.movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements visible to you.</p>
          ) : (
            <ol className="relative flex flex-col gap-3 border-l pl-4">
              {lot.movements.map((m) => (
                <li key={m.id} className="relative">
                  <span
                    aria-hidden
                    className={
                      "absolute -left-[21px] top-1.5 size-2.5 rounded-full " +
                      (m.grams >= 0 ? "bg-emerald-500" : "bg-red-500")
                    }
                  />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-sm font-medium">{MOVEMENT_TYPE_LABEL[m.type] ?? m.type}</span>
                    <SignedKg grams={m.grams} className="text-sm" />
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                    <span>
                      {formatLagosDateTime(m.occurredAt)} · {m.warehouseName}
                      {m.binName ? ` / ${m.binName}` : ""}
                      {m.bags ? ` · ${m.bags > 0 ? "+" : ""}${m.bags} bags` : ""}
                    </span>
                    <RefDocLink refType={m.refType} refId={m.refId} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
