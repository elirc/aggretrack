"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { saleTraceAction } from "@/actions/reports";
import { Skeleton } from "@/components/ui/skeleton";

import { sellingErrorMessage } from "./actions-client";
import { kg, naira } from "./format";

type TraceData = {
  suppliers: { supplierId: string; supplierName: string; allocatedKg: string; dispatchedKg: string; lots: number }[];
  margin: { revenueKobo: number; costKobo: number; expensesKobo: number; marginKobo: number; marginPercent: number } | null;
};

/** "Suppliers behind this sale" — loaded via saleTraceAction. */
export function SaleTracePanel({ salesOrderId }: { salesOrderId: string }) {
  const [data, setData] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    saleTraceAction({ salesOrderId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setData({ suppliers: res.data.trace.suppliers, margin: res.data.margin });
        else setError(sellingErrorMessage(res.error));
      })
      .catch(() => {
        if (!cancelled) setError(sellingErrorMessage("INTERNAL"));
      });
    return () => {
      cancelled = true;
    };
  }, [salesOrderId]);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">
        {error}
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading trace">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {data.suppliers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No lots allocated yet — suppliers appear once stock is reserved.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {data.suppliers.map((s) => (
            <li key={s.supplierId} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <Link href={`/suppliers/${s.supplierId}`} className="truncate font-medium hover:underline">
                  {s.supplierName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {s.lots} lot{s.lots === 1 ? "" : "s"}
                </p>
              </div>
              <div className="text-right text-sm tabular-nums">
                <p>{kg(s.allocatedKg)} allocated</p>
                <p className="text-xs text-muted-foreground">{kg(s.dispatchedKg)} dispatched</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.margin ? (
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-lg border p-2">
            <p className="text-xs text-muted-foreground">Revenue</p>
            <p className="font-semibold tabular-nums">{naira(data.margin.revenueKobo)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-xs text-muted-foreground">Landed cost</p>
            <p className="font-semibold tabular-nums">{naira(data.margin.costKobo)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-xs text-muted-foreground">Expenses</p>
            <p className="font-semibold tabular-nums">{naira(data.margin.expensesKobo)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-xs text-muted-foreground">Margin</p>
            <p className="font-semibold tabular-nums">
              {naira(data.margin.marginKobo)}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({data.margin.marginPercent.toFixed(1)}%)
              </span>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
