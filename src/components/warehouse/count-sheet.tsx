"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { createCountAction } from "@/actions/counts";
import { zKgString, zUuid } from "@/lib/validation/common";
import type { CreateCountInput } from "@/lib/validation/warehouse";
import { cn } from "@/lib/utils";

import { fmtBags, fmtGrams, fmtSignedGrams, kgInput, tryGrams } from "./format";
import type { LotOption, LotsByWarehouse } from "./position";
import { runWarehouseAction } from "./run-action";

const NO_BIN = "__none";

const sheetSchema = z.object({
  warehouseId: zUuid,
  rows: z.array(
    z.object({
      lotId: zUuid,
      binId: z.string(),
      countedKg: z.union([z.literal(""), zKgString]),
      countedBags: z.string().trim().regex(/^\d*$/, "Whole bags only"),
    }),
  ),
});
type Sheet = z.infer<typeof sheetSchema>;

type WarehouseOpt = { id: string; name: string; bins: { id: string; name: string }[] };

function defaultBin(l: LotOption): string {
  const withBin = l.bins.filter((b) => b.binId);
  if (withBin.length === 0) return NO_BIN;
  return [...withBin].sort((a, b) => b.grams - a.grams)[0].binId ?? NO_BIN;
}

function rowsFor(lots: LotOption[]): Sheet["rows"] {
  return lots.map((l) => ({ lotId: l.lotId, binId: defaultBin(l), countedKg: "", countedBags: "" }));
}

/** Count sheet: warehouse → lots with system kg, counted bags/kg inputs, live variance. */
export function CountSheet({
  warehouses,
  lots,
  thresholdGrams,
}: {
  warehouses: WarehouseOpt[];
  lots: LotsByWarehouse;
  thresholdGrams: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [byBin, setByBin] = useState(false);
  const initialWh = warehouses.length === 1 ? warehouses[0].id : "";
  const form = useForm<Sheet>({
    resolver: zodResolver(sheetSchema),
    defaultValues: { warehouseId: initialWh, rows: initialWh ? rowsFor(lots[initialWh] ?? []) : [] },
  });
  const rows = useFieldArray({ control: form.control, name: "rows" });
  const warehouseId = useWatch({ control: form.control, name: "warehouseId" });
  const watched = useWatch({ control: form.control, name: "rows" });

  const whLots = useMemo(() => (warehouseId ? (lots[warehouseId] ?? []) : []), [warehouseId, lots]);
  const lotById = useMemo(() => new Map(whLots.map((l) => [l.lotId, l])), [whLots]);
  const bins = warehouses.find((w) => w.id === warehouseId)?.bins ?? [];
  const binName = (id: string) => (id === NO_BIN ? "No bin" : (bins.find((b) => b.id === id)?.name ?? "Bin"));

  const variance = (i: number): number | null => {
    const lot = lotById.get(watched?.[i]?.lotId ?? "");
    const counted = tryGrams(watched?.[i]?.countedKg);
    if (!lot || counted === null || watched?.[i]?.countedKg === "") return null;
    return counted - lot.grams;
  };
  const entered = (watched ?? []).filter((r) => r.countedKg !== "").length;
  const variances = (watched ?? []).map((_r, i) => variance(i));
  const netVariance = variances.reduce<number>((s, v) => s + (v ?? 0), 0);
  const needApproval = variances.filter((v) => v !== null && Math.abs(v) > thresholdGrams).length;

  // Display order: optionally grouped by the row's bin.
  const order = rows.fields.map((f, i) => ({ f, i }));
  const groups: { key: string; title: string | null; items: typeof order }[] = byBin
    ? Object.values(
        order.reduce<Record<string, { key: string; title: string | null; items: typeof order }>>((acc, it) => {
          const key = watched?.[it.i]?.binId ?? NO_BIN;
          (acc[key] ??= { key, title: binName(key), items: [] }).items.push(it);
          return acc;
        }, {}),
      ).sort((a, b) => (a.key === NO_BIN ? 1 : b.key === NO_BIN ? -1 : (a.title ?? "").localeCompare(b.title ?? "")))
    : [{ key: "all", title: null, items: order }];

  const onSubmit = form.handleSubmit((values) => {
    const lines = values.rows.filter((r) => r.countedKg !== "");
    if (lines.length === 0) {
      toast.error("Enter a counted weight for at least one lot.");
      return;
    }
    const payload: CreateCountInput = {
      warehouseId: values.warehouseId,
      lines: lines.map((r) => ({
        lotId: r.lotId,
        binId: r.binId === NO_BIN ? null : r.binId,
        countedKg: r.countedKg,
        countedBags: r.countedBags === "" ? null : Number(r.countedBags),
      })),
    };
    startTransition(async () => {
      const res = await runWarehouseAction(createCountAction, payload, "Count saved as draft");
      if (res.ok) router.push(`/counts/${res.data.id}`);
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Controller
          name="warehouseId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="sm:max-w-xs">
              <FieldLabel htmlFor="cnt-wh">Warehouse</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v);
                  rows.replace(rowsFor(lots[v] ?? []));
                }}
              >
                <SelectTrigger id="cnt-wh" className="h-11 w-full" aria-invalid={fieldState.invalid}>
                  <SelectValue placeholder="Choose warehouse…" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        {bins.length > 0 && rows.fields.length > 0 ? (
          <div className="flex items-center gap-2">
            <Switch id="cnt-bybin" checked={byBin} onCheckedChange={setByBin} />
            <Label htmlFor="cnt-bybin">Group by bin</Label>
          </div>
        ) : null}
      </div>

      {!warehouseId ? (
        <p className="text-sm text-muted-foreground">Pick a warehouse to load its count sheet.</p>
      ) : rows.fields.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No stock on hand in this warehouse to count.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="flex flex-col gap-2">
            {g.title ? (
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.title}</h2>
            ) : null}
            <ul className="flex flex-col gap-2">
              {g.items.map(({ f, i }) => {
                const lot = lotById.get(f.lotId);
                if (!lot) return null;
                const v = variances[i];
                const big = v !== null && Math.abs(v) > thresholdGrams;
                return (
                  <li
                    key={f.id}
                    className={cn(
                      "flex flex-col gap-2 rounded-md border p-3",
                      v !== null && v !== 0 && (big ? "border-red-300 dark:border-red-800" : "border-amber-300 dark:border-amber-800"),
                    )}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="flex flex-col">
                        <span className="font-mono text-sm">{lot.lotNumber}</span>
                        <span className="text-xs text-muted-foreground">
                          {lot.commodityName} {lot.gradeName}
                        </span>
                      </span>
                      <span className="text-right text-xs">
                        <span className="block text-muted-foreground">System</span>
                        <span className="font-medium tabular-nums">
                          {fmtGrams(lot.grams)} · {fmtBags(lot.bags)}
                        </span>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Controller
                        name={`rows.${i}.countedKg`}
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid || undefined}>
                            <FieldLabel htmlFor={`cnt-kg-${i}`}>Counted kg</FieldLabel>
                            <div className="flex gap-1">
                              <Input
                                id={`cnt-kg-${i}`}
                                {...field}
                                inputMode="decimal"
                                autoComplete="off"
                                className="h-11"
                                aria-invalid={fieldState.invalid}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="size-11 shrink-0"
                                aria-label={`Counted matches system for ${lot.lotNumber}`}
                                title="Matches system"
                                onClick={() => {
                                  form.setValue(`rows.${i}.countedKg`, kgInput(lot.kg), { shouldValidate: true });
                                  if (!watched?.[i]?.countedBags) {
                                    form.setValue(`rows.${i}.countedBags`, String(lot.bags));
                                  }
                                }}
                              >
                                <Check />
                              </Button>
                            </div>
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name={`rows.${i}.countedBags`}
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid || undefined}>
                            <FieldLabel htmlFor={`cnt-bags-${i}`}>Counted bags</FieldLabel>
                            <Input
                              id={`cnt-bags-${i}`}
                              {...field}
                              inputMode="numeric"
                              autoComplete="off"
                              className="h-11"
                              aria-invalid={fieldState.invalid}
                            />
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      {bins.length > 0 ? (
                        <Controller
                          name={`rows.${i}.binId`}
                          control={form.control}
                          render={({ field }) => (
                            <Field>
                              <FieldLabel htmlFor={`cnt-bin-${i}`}>Bin</FieldLabel>
                              <Select value={field.value} onValueChange={field.onChange}>
                                <SelectTrigger id={`cnt-bin-${i}`} className="h-11 w-full">
                                  <SelectValue placeholder="No bin" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NO_BIN}>No bin</SelectItem>
                                  {bins.map((b) => (
                                    <SelectItem key={b.id} value={b.id}>
                                      {b.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          )}
                        />
                      ) : null}
                      <div className="flex flex-col justify-end">
                        <span className="text-xs text-muted-foreground">Variance</span>
                        <span
                          aria-live="polite"
                          className={cn(
                            "flex h-11 items-center font-medium tabular-nums",
                            v !== null && v > 0 && "text-emerald-700 dark:text-emerald-400",
                            v !== null && v < 0 && "text-red-700 dark:text-red-400",
                          )}
                        >
                          {v === null ? "—" : v === 0 ? "Matches" : fmtSignedGrams(v)}
                        </span>
                        {big ? <span className="text-[11px] text-red-700 dark:text-red-400">Needs approval</span> : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {rows.fields.length > 0 ? (
        <div className="sticky bottom-20 flex flex-col gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <span>
            {entered} of {rows.fields.length} counted · net{" "}
            <span
              className={cn(
                "font-medium tabular-nums",
                netVariance > 0 && "text-emerald-700 dark:text-emerald-400",
                netVariance < 0 && "text-red-700 dark:text-red-400",
              )}
            >
              {fmtSignedGrams(netVariance)}
            </span>
            {needApproval > 0 ? ` · ${needApproval} need approval` : ""}
          </span>
          <Button type="submit" className="h-11 sm:h-9" disabled={pending || entered === 0}>
            {pending ? "Saving…" : "Save count"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
