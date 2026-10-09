import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtBags, fmtGrams, fmtKg, formatLagosDateTime } from "@/components/warehouse/format";
import { lotLabels, orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { NoAccess, Notice, Stat, StatusBadge } from "@/components/warehouse/status";
import { DraftTransferActions, ReceiveTransferForm } from "@/components/warehouse/transfer-actions";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { isDomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import * as md from "@/lib/services/masterData";
import { getTransfer, type TransferWithLines } from "@/lib/services/transfers";
import { zUuid } from "@/lib/validation/common";

export const metadata = { title: "Transfer · AggreTrack" };

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "transfer.read")) return <NoAccess title="Transfer" what="transfers" />;

  const { id } = await params;
  if (!zUuid.safeParse(id).success) notFound();

  let t: TransferWithLines;
  try {
    t = await getTransfer(db, ctx, id);
  } catch (err) {
    if (isDomainError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const [warehouses, lotMap] = await Promise.all([
    orgWarehouseLabels(ctx),
    lotLabels(
      ctx,
      t.lines.map((l) => l.lotId),
    ),
  ]);
  const wh = (wid: string) => warehouses.find((w) => w.id === wid)?.name ?? "Unknown warehouse";
  const allowed = ctx.restrictions.warehouseIds;
  const hasAccess = (wid: string) => allowed === null || allowed.includes(wid);

  const canDispatch = t.status === "draft" && can(ctx.role, "transfer.write") && !ctx.readOnly && hasAccess(t.fromWarehouseId);
  const canReceive =
    t.status === "in_transit" && can(ctx.role, "transfer.receive") && !ctx.readOnly && hasAccess(t.toWarehouseId);

  let bins: { id: string; name: string }[] = [];
  if (canReceive) {
    try {
      const dest = await md.getWarehouse(db, ctx, t.toWarehouseId);
      bins = dest.bins.map((b) => ({ id: b.id, name: b.name }));
    } catch {
      bins = [];
    }
  }

  const sentG = t.lines.reduce((s, l) => s + kgToGrams(l.kg), 0);
  const sentBags = t.lines.reduce((s, l) => s + l.bags, 0);
  const lossG = t.lines.reduce((s, l) => s + (l.lossKg ? kgToGrams(l.lossKg) : 0), 0);
  const label = (lotId: string) => {
    const l = lotMap.get(lotId);
    return l ? `${l.lotNumber} · ${l.commodityName} ${l.gradeName}` : lotId.slice(0, 8);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Transfer ${t.transferNumber}`}
        description={`${wh(t.fromWarehouseId)} → ${wh(t.toWarehouseId)}`}
        actions={<StatusBadge status={t.status} />}
      />

      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
          <Stat
            label="Route"
            className="col-span-2"
            value={
              <span className="inline-flex flex-wrap items-center gap-1">
                {wh(t.fromWarehouseId)} <ArrowRight className="size-3.5" /> {wh(t.toWarehouseId)}
              </span>
            }
          />
          <Stat label="Sent" value={`${fmtGrams(sentG)} · ${fmtBags(sentBags)}`} />
          {t.status === "received" ? (
            <Stat
              label="Transit loss"
              value={<span className={lossG > 0 ? "text-red-700 dark:text-red-400" : undefined}>{fmtGrams(lossG)}</span>}
            />
          ) : null}
          <Stat label="Created" value={formatLagosDateTime(t.createdAt)} />
          {t.dispatchedAt ? <Stat label="Dispatched" value={formatLagosDateTime(t.dispatchedAt)} /> : null}
          {t.receivedAt ? <Stat label="Received" value={formatLagosDateTime(t.receivedAt)} /> : null}
        </CardContent>
      </Card>

      {canReceive ? (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Receive</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <ReceiveTransferForm
              transferId={t.id}
              bins={bins}
              lines={t.lines.map((l) => ({
                lineId: l.id,
                lotLabel: label(l.lotId),
                sentKg: l.kg,
                sentBags: l.bags,
              }))}
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Lines</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <ul className="flex flex-col divide-y rounded-md border">
              {t.lines.map((l) => {
                const loss = l.lossKg ? kgToGrams(l.lossKg) : 0;
                return (
                  <li key={l.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={`/stock/lots/${l.lotId}`} className="font-mono underline-offset-4 hover:underline">
                        {label(l.lotId)}
                      </Link>
                      <span className="tabular-nums">
                        {fmtKg(l.kg)} · {fmtBags(l.bags)}
                      </span>
                    </span>
                    {l.receivedKg !== null ? (
                      <span className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          Received {fmtKg(l.receivedKg)} · {fmtBags(l.receivedBags)}
                        </span>
                        <span className={loss > 0 ? "text-red-700 dark:text-red-400" : undefined}>
                          Loss {fmtGrams(loss)}
                        </span>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {t.status === "in_transit" && !canReceive ? (
        <Notice>In transit — the destination warehouse records the receipt.</Notice>
      ) : null}
      {t.status === "draft" ? (
        canDispatch ? (
          <DraftTransferActions transferId={t.id} canDispatch totalLabel={fmtGrams(sentG)} />
        ) : (
          <Notice>Draft — the source warehouse dispatches it.</Notice>
        )
      ) : null}
    </div>
  );
}
