"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createTransferAction } from "@/actions/transfers";
import { createTransferInput } from "@/lib/validation/warehouse";

import { fmtBags, fmtGrams, kgInput, tryGrams } from "./format";
import { lotOptionLabel, type LotOption, type LotsByWarehouse } from "./position";
import { runWarehouseAction } from "./run-action";

type In = z.input<typeof createTransferInput>;
type Out = z.output<typeof createTransferInput>;
type Opt = { id: string; name: string };

/** Source warehouse → lot picker (on-hand per lot) → lines with kg/bags. */
export function TransferForm({
  sources,
  destinations,
  lots,
}: {
  sources: Opt[];
  destinations: Opt[];
  lots: LotsByWarehouse;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const form = useForm<In, unknown, Out>({
    resolver: zodResolver(createTransferInput),
    defaultValues: { fromWarehouseId: sources.length === 1 ? sources[0].id : "", toWarehouseId: "", lines: [] },
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const from = useWatch({ control: form.control, name: "fromWarehouseId" });
  const watchedLines = useWatch({ control: form.control, name: "lines" });

  const sourceLots: LotOption[] = useMemo(() => (from ? (lots[from] ?? []) : []), [from, lots]);
  const lotById = useMemo(() => new Map(sourceLots.map((l) => [l.lotId, l])), [sourceLots]);
  const picked = new Set((watchedLines ?? []).map((l) => l.lotId));
  const q = search.trim().toLowerCase();
  const available = sourceLots.filter(
    (l) => !picked.has(l.lotId) && (!q || lotOptionLabel(l).toLowerCase().includes(q)),
  );

  const totalGrams = (watchedLines ?? []).reduce((s, l) => s + (tryGrams(l.kg) ?? 0), 0);

  const onSubmit = form.handleSubmit((values) => {
    let over = false;
    values.lines.forEach((l, i) => {
      const lot = lotById.get(l.lotId);
      const g = tryGrams(l.kg) ?? 0;
      if (lot && g > lot.grams) {
        form.setError(`lines.${i}.kg`, { message: `Only ${fmtGrams(lot.grams)} on hand` });
        over = true;
      }
      if (lot && Number(l.bags) > lot.bags) {
        form.setError(`lines.${i}.bags`, { message: `Only ${lot.bags} bags on hand` });
        over = true;
      }
    });
    if (over) return;
    startTransition(async () => {
      const res = await runWarehouseAction(createTransferAction, values, "Transfer created");
      if (res.ok) router.push(`/transfers/${res.data.id}`);
      else if (res.fieldErrors?.toWarehouseId?.[0]) {
        form.setError("toWarehouseId", { message: res.fieldErrors.toWarehouseId[0] });
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Controller
          name="fromWarehouseId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="trf-from">From warehouse</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v);
                  lines.replace([]);
                }}
              >
                <SelectTrigger id="trf-from" className="h-11 w-full" aria-invalid={fieldState.invalid}>
                  <SelectValue placeholder="Choose source…" />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((w) => (
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
        <Controller
          name="toWarehouseId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="trf-to">To warehouse</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="trf-to" className="h-11 w-full" aria-invalid={fieldState.invalid}>
                  <SelectValue placeholder="Choose destination…" />
                </SelectTrigger>
                <SelectContent>
                  {destinations
                    .filter((w) => w.id !== from)
                    .map((w) => (
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
      </FieldGroup>

      {from ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Lots on hand</h2>
            <span className="text-xs text-muted-foreground">{sourceLots.length} lots</span>
          </div>
          {sourceLots.length > 6 ? (
            <Input
              className="h-11"
              placeholder="Search lot, commodity or grade"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search lots"
            />
          ) : null}
          {sourceLots.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No stock on hand in this warehouse.
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
              {available.map((l) => (
                <li key={l.lotId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-sm">{l.lotNumber}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {l.commodityName} {l.gradeName}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-right text-xs tabular-nums">
                      <span className="block font-medium">{fmtGrams(l.grams)}</span>
                      <span className="text-muted-foreground">{fmtBags(l.bags)}</span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-11 sm:size-9"
                      aria-label={`Add lot ${l.lotNumber}`}
                      onClick={() => lines.append({ lotId: l.lotId, kg: kgInput(l.kg), bags: String(l.bags) })}
                    >
                      <Plus />
                    </Button>
                  </span>
                </li>
              ))}
              {available.length === 0 ? (
                <li className="px-3 py-4 text-center text-sm text-muted-foreground">No more lots to add.</li>
              ) : null}
            </ul>
          )}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Pick the source warehouse to see its lots.</p>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Lines</h2>
          <span className="text-sm font-medium tabular-nums">{fmtGrams(totalGrams)}</span>
        </div>
        {lines.fields.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            Add lots from the list above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.fields.map((f, i) => {
              const lot = lotById.get(f.lotId);
              const g = tryGrams(watchedLines?.[i]?.kg) ?? 0;
              const overKg = lot ? g > lot.grams : false;
              return (
                <li key={f.id} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex flex-col">
                      <span className="font-mono text-sm">{lot?.lotNumber ?? f.lotId.slice(0, 8)}</span>
                      <span className="text-xs text-muted-foreground">
                        {lot ? `${lot.commodityName} ${lot.gradeName} · on hand ${fmtGrams(lot.grams)}` : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-9"
                      aria-label="Remove line"
                      onClick={() => lines.remove(i)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Controller
                      name={`lines.${i}.kg`}
                      control={form.control}
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid || overKg || undefined}>
                          <FieldLabel htmlFor={`trf-kg-${i}`}>Kg</FieldLabel>
                          <Input
                            id={`trf-kg-${i}`}
                            {...field}
                            value={field.value ?? ""}
                            inputMode="decimal"
                            autoComplete="off"
                            className="h-11"
                            aria-invalid={fieldState.invalid || overKg}
                          />
                          <FieldError
                            errors={[fieldState.error ?? (overKg && lot ? { message: `Only ${fmtGrams(lot.grams)} on hand` } : undefined)]}
                          />
                        </Field>
                      )}
                    />
                    <Controller
                      name={`lines.${i}.bags`}
                      control={form.control}
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid || undefined}>
                          <FieldLabel htmlFor={`trf-bags-${i}`}>Bags</FieldLabel>
                          <Input
                            id={`trf-bags-${i}`}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={field.value === undefined || field.value === null ? "" : String(field.value)}
                            onChange={(e) => field.onChange(e.target.value)}
                            inputMode="numeric"
                            autoComplete="off"
                            className="h-11"
                            aria-invalid={fieldState.invalid}
                          />
                          <FieldError errors={[fieldState.error]} />
                        </Field>
                      )}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <FieldError errors={[form.formState.errors.lines?.root ?? form.formState.errors.lines]} />
      </section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => router.push("/transfers")}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : "Create draft transfer"}
        </Button>
      </div>
    </form>
  );
}
