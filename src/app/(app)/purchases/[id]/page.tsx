import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";

import {
  DEDUCTION_REASON_LABELS,
  displayDate,
  displayDateTime,
  displayKg,
  naira,
  nairaPerKg,
} from "@/components/buying/format";
import { orNotFound, requireOrgContext, uuidParamOr404 } from "@/components/buying/server";
import { NoAccess, ReadOnlyNotice } from "@/components/buying/states";
import { PurchaseStatusBadge } from "@/components/buying/status-badge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { listWarehouses } from "@/lib/services/masterData";
import { getPurchaseDetail, type PurchaseDetail } from "@/lib/services/purchases";
import { cn } from "@/lib/utils";

import { PurchaseActions } from "./_components/purchase-actions";

export const metadata = { title: "Purchase · AggreTrack" };

type Step = { label: string; detail?: string; at?: Date | null; state: "done" | "current" | "todo" | "stopped" };

function timeline(p: PurchaseDetail): Step[] {
  const steps: Step[] = [
    {
      label: p.createdOffline ? "Recorded offline" : "Recorded",
      at: p.clientCreatedAt ?? p.createdAt,
      detail: p.createdOffline ? `Synced ${displayDateTime(p.createdAt)}` : undefined,
      state: "done",
    },
  ];
  if (p.status === "cancelled") {
    steps.push({ label: "Cancelled", at: p.updatedAt, state: "stopped" });
    return steps;
  }
  if (p.status === "draft") {
    steps.push(
      p.rejectedReason
        ? { label: "Sent back", detail: p.rejectedReason, at: p.updatedAt, state: "stopped" }
        : { label: "Draft — not submitted yet", state: "current" },
    );
  }
  if (p.requiresApproval) {
    steps.push({
      label: p.approvedAt ? "Approved over guide" : "Waiting for manager approval",
      detail: p.approvedAt ? undefined : "A price is above the day's guide.",
      at: p.approvedAt,
      state: p.approvedAt ? "done" : p.status === "pending_approval" ? "current" : "todo",
    });
  } else if (p.status !== "draft") {
    steps.push({ label: "Approved", detail: "Within price guide", state: "done" });
  }
  steps.push({
    label: p.receivedAt ? `Received · ${p.grnNumber ?? ""}` : "Receive into warehouse",
    at: p.receivedAt,
    state: p.receivedAt ? "done" : p.status === "approved" ? "current" : "todo",
  });
  return steps;
}

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "purchase.read")) {
    return (
      <div>
        <PageHeader title="Purchase" />
        <NoAccess what="purchases" />
      </div>
    );
  }
  const id = uuidParamOr404((await params).id);
  const p = await orNotFound(getPurchaseDetail(db, ctx, id));
  const hidePrices = ctx.restrictions.hidePrices;
  const writable = !ctx.readOnly;

  const canReceive = writable && p.status === "approved" && can(ctx.role, "purchase.receive");
  const warehouses = canReceive ? await listWarehouses(db, ctx) : [];
  const flags = {
    canApprove: writable && p.status === "pending_approval" && can(ctx.role, "purchase.approve"),
    canReceive,
    canCancel: writable && p.status !== "received" && p.status !== "cancelled" && can(ctx.role, "purchase.create"),
    canEdit:
      writable && (p.status === "draft" || p.status === "pending_approval") && can(ctx.role, "purchase.create"),
  };
  const steps = timeline(p);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/purchases" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" /> Purchases
        </Link>
        <PageHeader
          title={p.purchaseNumber ?? "Purchase"}
          description={`${displayDate(p.purchaseDate)}${p.buyingPointName ? ` · ${p.buyingPointName}` : ""}`}
          actions={<PurchaseStatusBadge status={p.status} className="h-7 px-3 text-sm" />}
        />
        {ctx.readOnly ? <ReadOnlyNotice /> : null}
      </div>

      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Supplier</p>
            {can(ctx.role, "supplier.read") ? (
              <Link href={`/suppliers/${p.supplierId}`} className="font-medium underline-offset-4 hover:underline">
                {p.supplierName}
              </Link>
            ) : (
              <p className="font-medium">{p.supplierName}</p>
            )}
            {p.supplierPhone ? <p className="text-xs text-muted-foreground">{p.supplierPhone}</p> : null}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net weight</p>
            <p className="font-semibold tabular-nums">{displayKg(p.netKg)}</p>
          </div>
          {hidePrices ? null : (
            <div>
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className="font-semibold tabular-nums">{naira(p.totalAmountKobo)}</p>
            </div>
          )}
          {p.grnNumber ? (
            <div className="col-span-2 sm:col-span-4">
              <p className="text-xs text-muted-foreground">Goods received note</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.grnNumber}</span>
                {p.grnDocumentId ? (
                  <Button asChild variant="outline" size="sm" className="h-9">
                    <a href={`/api/documents/${p.grnDocumentId}`} target="_blank" rel="noreferrer">
                      <FileText /> GRN PDF
                    </a>
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">PDF is being generated — refresh shortly.</span>
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <PurchaseActions
        purchaseId={p.id}
        purchaseNumber={p.purchaseNumber}
        {...flags}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, bins: w.bins.map((b) => ({ id: b.id, name: b.name })) }))}
        supplierHasPhone={!!p.supplierPhone}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Lines</h2>
        <ul className="flex flex-col gap-2">
          {p.lines.map((l, i) => (
            <li key={l.id}>
              <Card className="gap-2 py-3">
                <CardContent className="flex flex-col gap-2 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {i + 1}. {l.commodityName} · {l.gradeName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {l.bags > 0 ? `${l.bags} bags` : "No bags"}
                        {l.bagTypeName ? ` · ${l.bagTypeName}` : ""}
                        {l.moisturePercent ? ` · ${l.moisturePercent}% moisture` : ""}
                      </p>
                    </div>
                    {l.overGuide ? (
                      <Badge
                        variant="outline"
                        className="border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                      >
                        Over guide
                      </Badge>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Gross</dt>
                      <dd className="tabular-nums">{displayKg(l.grossKg)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Net</dt>
                      <dd className="font-medium tabular-nums">{displayKg(l.netKg)}</dd>
                    </div>
                    {hidePrices ? null : (
                      <>
                        <div>
                          <dt className="text-xs text-muted-foreground">Price</dt>
                          <dd className="tabular-nums">{nairaPerKg(l.pricePerKgKobo)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Amount</dt>
                          <dd className="font-medium tabular-nums">{naira(l.amountKobo)}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  {l.deductions.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5 text-xs">
                      {l.deductions.map((d) => (
                        <li key={d.id} className="rounded-md bg-muted px-2 py-1">
                          {DEDUCTION_REASON_LABELS[d.reason]} −{displayKg(d.kg)}
                          {d.note?.startsWith("auto") ? " (auto)" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {l.lot ? (
                    <p className="text-xs">
                      Lot{" "}
                      <Link href={`/stock/lots/${l.lot.id}`} className="font-medium underline-offset-4 hover:underline">
                        {l.lot.lotNumber}
                      </Link>
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <ol className="relative flex flex-col gap-4 border-l pl-5">
            {steps.map((s, i) => (
              <li key={i} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-1 -left-[26.5px] size-3 rounded-full border-2 bg-background",
                    s.state === "done" && "border-emerald-500 bg-emerald-500",
                    s.state === "current" && "border-sky-500",
                    s.state === "todo" && "border-muted-foreground/40",
                    s.state === "stopped" && "border-destructive bg-destructive",
                  )}
                />
                <p className={cn("text-sm font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</p>
                {s.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
                {s.at ? <p className="text-xs text-muted-foreground">{displayDateTime(s.at)}</p> : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
