"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hand } from "lucide-react";

import { listAvailableLotsAction, reserveForSalesLineAction } from "@/actions/sales";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import { callAction, sellingErrorMessage } from "./actions-client";
import { gramsToKgInput, kg, kgFromGrams, lagosDate, parseKgInput, pct } from "./format";
import { kgToGrams } from "@/lib/domain/units";

type AvailableLot = {
  lotId: string;
  lotNumber: string;
  warehouseId: string;
  warehouseName: string;
  receivedAt: Date | string;
  availableKg: string;
};

const keyOf = (l: { lotId: string; warehouseId: string }) => `${l.lotId}:${l.warehouseId}`;

/** Manual lot picker for one sales line: available lots oldest-first, kg per lot, running coverage. */
export function ManualAllocateSheet({
  salesLineId,
  commodityId,
  gradeId,
  label,
  remainingKg,
}: {
  salesLineId: string;
  commodityId: string;
  gradeId: string;
  label: string;
  remainingKg: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lots, setLots] = useState<AvailableLot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const remainingG = kgToGrams(remainingKg);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listAvailableLotsAction({ commodityId, gradeId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setLots(res.data);
          setLoadError(null);
        } else {
          setLoadError(sellingErrorMessage(res.error));
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(sellingErrorMessage("INTERNAL"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, commodityId, gradeId]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setLots(null);
      setLoadError(null);
      setPicks({});
    }
  };

  let pickedG = 0;
  let invalid = false;
  const rowErrors: Record<string, string | undefined> = {};
  for (const l of lots ?? []) {
    const raw = picks[keyOf(l)];
    if (!raw || raw.trim() === "") continue;
    const g = parseKgInput(raw);
    if (g === null) {
      rowErrors[keyOf(l)] = "Enter kg (up to 3 decimals)";
      invalid = true;
      continue;
    }
    if (g > kgToGrams(l.availableKg)) {
      rowErrors[keyOf(l)] = "More than available";
      invalid = true;
    }
    pickedG += g;
  }
  const over = pickedG > remainingG;
  const canSubmit = !invalid && !over && pickedG > 0 && !pending;

  const fill = (l: AvailableLot) => {
    const others = pickedG - (parseKgInput(picks[keyOf(l)]) ?? 0);
    const room = Math.max(0, Math.min(kgToGrams(l.availableKg), remainingG - others));
    setPicks((p) => ({ ...p, [keyOf(l)]: room > 0 ? gramsToKgInput(room) : "" }));
  };

  const submit = () => {
    const chosen = (lots ?? [])
      .map((l) => ({ lotId: l.lotId, warehouseId: l.warehouseId, kg: (picks[keyOf(l)] ?? "").trim() }))
      .filter((p) => (parseKgInput(p.kg) ?? 0) > 0);
    startTransition(async () => {
      const res = await callAction(
        reserveForSalesLineAction,
        { salesLineId, mode: "manual", picks: chosen },
        "Stock reserved",
      );
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" className="h-11 sm:h-9">
          <Hand /> Pick lots
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Pick lots</SheetTitle>
          <SheetDescription>
            {label} · {kg(remainingKg)} still to cover. Oldest lots are listed first.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 px-4">
          <div className="sticky top-0 z-10 rounded-lg border bg-popover p-3">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>Coverage</span>
              <span className={over ? "font-semibold text-destructive tabular-nums" : "font-semibold tabular-nums"}>
                {kgFromGrams(pickedG)} / {kgFromGrams(remainingG)}
              </span>
            </div>
            <Progress value={pct(pickedG, remainingG)} aria-label="Coverage" />
            {over ? (
              <p role="alert" className="mt-1 text-xs text-destructive">
                Picks exceed what this line still needs.
              </p>
            ) : null}
          </div>

          {loadError ? (
            <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">
              {loadError}
            </p>
          ) : lots === null ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading lots">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : lots.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No available stock for this commodity and grade.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {lots.map((l) => {
                const k = keyOf(l);
                const err = rowErrors[k];
                return (
                  <li key={k} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{l.lotNumber}</p>
                        <p className="text-xs text-muted-foreground">
                          {l.warehouseName} · received {lagosDate(l.receivedAt)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Available</p>
                        <p className="text-sm font-semibold tabular-nums">{kg(l.availableKg)}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Input
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="kg"
                        className="h-11 min-w-0 flex-1"
                        value={picks[k] ?? ""}
                        onChange={(e) => setPicks((p) => ({ ...p, [k]: e.target.value }))}
                        aria-label={`Kg from ${l.lotNumber}`}
                        aria-invalid={!!err}
                      />
                      <Button type="button" variant="secondary" className="h-11 shrink-0" onClick={() => fill(l)}>
                        Fill
                      </Button>
                    </div>
                    {err ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {err}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <SheetFooter className="px-4 pb-6">
          <Button className="h-11" disabled={!canSubmit} onClick={submit}>
            {pending ? "Reserving…" : `Reserve ${kgFromGrams(pickedG)}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
