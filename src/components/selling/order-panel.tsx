"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Sparkles, XCircle } from "lucide-react";

import {
  autoAllocateOrderAction,
  cancelSalesOrderAction,
  confirmSalesOrderAction,
  releaseAllocationAction,
} from "@/actions/sales";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { kgToGrams } from "@/lib/domain/units";

import { callAction } from "./actions-client";
import { kg, kgFromGrams, lagosDate, naira, pct } from "./format";
import { ManualAllocateSheet } from "./manual-allocate-sheet";
import { AllocationStatusBadge } from "./status";

export type OrderLine = {
  id: string;
  commodityId: string;
  gradeId: string;
  commodityName: string;
  gradeName: string;
  kg: string;
  pricePerKgKobo: number | null;
  amountKobo: number | null;
  reservedKg: string;
  dispatchedKg: string;
  remainingKg: string;
  fullyAllocated: boolean;
  allocations: {
    id: string;
    lotNumber: string;
    warehouseName: string;
    kg: string;
    status: string;
    receivedAt: Date | string;
  }[];
};

const ALLOCATABLE = new Set(["confirmed", "allocated"]);
const CANCELLABLE = new Set(["draft", "confirmed", "allocated"]);

/** Confirm / auto-allocate / cancel buttons for the order header. */
export function OrderActions({
  orderId,
  status,
  canWrite,
  canAllocate,
  hasRemaining,
}: {
  orderId: string;
  status: string;
  canWrite: boolean;
  canAllocate: boolean;
  hasRemaining: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
    });

  const showConfirm = canWrite && status === "draft";
  const showAuto = canAllocate && ALLOCATABLE.has(status) && hasRemaining;
  const showCancel = canWrite && CANCELLABLE.has(status);
  if (!showConfirm && !showAuto && !showCancel) return null;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {showConfirm ? (
        <Button
          className="h-11 sm:h-9"
          disabled={pending}
          onClick={() => run(() => callAction(confirmSalesOrderAction, { id: orderId }, "Order confirmed"))}
        >
          <CheckCircle2 /> Confirm order
        </Button>
      ) : null}
      {showAuto ? (
        <Button
          className="h-11 sm:h-9"
          disabled={pending}
          onClick={() =>
            run(() => callAction(autoAllocateOrderAction, { salesOrderId: orderId }, "Allocated oldest lots first"))
          }
        >
          <Sparkles /> Auto-allocate (FIFO)
        </Button>
      ) : null}
      {showCancel ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="h-11 sm:h-9" disabled={pending}>
              <XCircle /> Cancel order
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
              <AlertDialogDescription>
                Any reserved stock is released back to the lots. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11 sm:h-8">Keep order</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                className="h-11 sm:h-8"
                onClick={() => run(() => callAction(cancelSalesOrderAction, { id: orderId }, "Order cancelled"))}
              >
                Cancel order
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

/** Lines with per-line allocation progress, manual picker and release. */
export function AllocationLines({
  status,
  lines,
  canAllocate,
  hidePrices,
}: {
  status: string;
  lines: OrderLine[];
  canAllocate: boolean;
  hidePrices: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const allocatable = canAllocate && ALLOCATABLE.has(status);

  const release = (allocationId: string) =>
    startTransition(async () => {
      const res = await callAction(releaseAllocationAction, { allocationId }, "Reservation released");
      if (res.ok) router.refresh();
    });

  return (
    <ul className="flex flex-col gap-3">
      {lines.map((l) => {
        const requestedG = kgToGrams(l.kg);
        const coveredG = kgToGrams(l.reservedKg) + kgToGrams(l.dispatchedKg);
        const visibleAllocations = l.allocations.filter((a) => a.status !== "cancelled");
        return (
          <li key={l.id}>
            <Card className="py-3">
              <CardContent className="flex flex-col gap-3 px-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {l.commodityName} · {l.gradeName}
                    </p>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {kg(l.kg)}
                      {hidePrices ? null : <> @ {naira(l.pricePerKgKobo)}/kg</>}
                    </p>
                  </div>
                  {hidePrices ? null : (
                    <p className="shrink-0 text-right font-semibold tabular-nums">{naira(l.amountKobo)}</p>
                  )}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Allocated</span>
                    <span className="tabular-nums">
                      {kgFromGrams(coveredG)} / {kg(l.kg)}
                    </span>
                  </div>
                  <Progress value={pct(coveredG, requestedG)} aria-label={`Allocated ${pct(coveredG, requestedG)}%`} />
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    Reserved {kg(l.reservedKg)} · Dispatched {kg(l.dispatchedKg)} · Remaining {kg(l.remainingKg)}
                  </p>
                </div>

                {visibleAllocations.length > 0 ? (
                  <ul className="flex flex-col divide-y rounded-md border">
                    {visibleAllocations.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2 px-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{a.lotNumber}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {a.warehouseName} · {lagosDate(a.receivedAt)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-sm tabular-nums">{kg(a.kg)}</span>
                          <AllocationStatusBadge status={a.status} />
                          {allocatable && a.status === "reserved" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9"
                              disabled={pending}
                              onClick={() => release(a.id)}
                              aria-label={`Release ${a.lotNumber}`}
                            >
                              Release
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {allocatable && !l.fullyAllocated ? (
                  <div className="flex">
                    <ManualAllocateSheet
                      salesLineId={l.id}
                      commodityId={l.commodityId}
                      gradeId={l.gradeId}
                      label={`${l.commodityName} · ${l.gradeName}`}
                      remainingKg={l.remainingKg}
                    />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
