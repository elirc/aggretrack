"use client";

import { Controller, useFieldArray, type Control, type UseFormSetValue } from "react-hook-form";
import { Info, Plus, Trash, TriangleAlert } from "lucide-react";

import { DEDUCTION_REASON_LABELS, displayGrams, displayKg, naira, nairaPerKg } from "@/components/buying/format";
import type { LineCalc } from "@/components/buying/line-math";
import type { GuideState } from "@/components/buying/use-price-guides";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { PurchaseFormValues } from "./purchase-schema";

export type CommodityOption = { id: string; name: string };
export type GradeOption = { id: string; name: string; commodityId: string };
export type BagTypeOption = { id: string; name: string; standardKg: string; sackWeightKg: string };

const NO_BAG = "__none__";

/** One purchase line: commodity → grade cascade, bags, weights, deductions, price and live totals. */
export function LineEditor({
  index,
  control,
  setValue,
  commodities,
  grades,
  bagTypes,
  commodityId,
  calc,
  guide,
  canRemove,
  onRemove,
}: {
  index: number;
  control: Control<PurchaseFormValues>;
  setValue: UseFormSetValue<PurchaseFormValues>;
  commodities: CommodityOption[];
  grades: GradeOption[];
  bagTypes: BagTypeOption[];
  commodityId: string;
  calc: LineCalc;
  guide: GuideState;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const deductions = useFieldArray({ control, name: `lines.${index}.deductions` });
  const gradeOptions = grades.filter((g) => g.commodityId === commodityId);
  const overGuide = guide && calc.priceKobo !== null && calc.priceKobo > guide.maxPricePerKgKobo;
  const fid = (n: string) => `l${index}-${n}`;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-4 px-3 py-4 sm:px-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Line {index + 1}</p>
          <div className="flex items-center gap-2">
            {overGuide ? (
              <Badge
                variant="outline"
                className="border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
              >
                <TriangleAlert /> Over guide
              </Badge>
            ) : null}
            {canRemove ? (
              <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove line ${index + 1}`} onClick={onRemove}>
                <Trash />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Controller
            name={`lines.${index}.commodityId`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("commodity")}>Commodity</FieldLabel>
                <Select
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v);
                    const g = grades.filter((x) => x.commodityId === v);
                    setValue(`lines.${index}.gradeId`, g.length === 1 ? g[0].id : "", { shouldValidate: false });
                  }}
                >
                  <SelectTrigger id={fid("commodity")} className="h-12 w-full" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder="Pick commodity" />
                  </SelectTrigger>
                  <SelectContent>
                    {commodities.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="min-h-10">
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name={`lines.${index}.gradeId`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("grade")}>Grade</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={!commodityId}>
                  <SelectTrigger id={fid("grade")} className="h-12 w-full" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder={commodityId ? "Pick grade" : "Pick commodity first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {gradeOptions.map((g) => (
                      <SelectItem key={g.id} value={g.id} className="min-h-10">
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {commodityId && gradeOptions.length === 0 ? (
                  <FieldDescription>This commodity has no grades yet — add one in master data.</FieldDescription>
                ) : null}
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>

        <Controller
          name={`lines.${index}.bagTypeId`}
          control={control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor={fid("bag")}>Bag type</FieldLabel>
              <Select value={field.value || NO_BAG} onValueChange={(v) => field.onChange(v === NO_BAG ? "" : v)}>
                <SelectTrigger id={fid("bag")} className="h-12 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BAG} className="min-h-10">
                    No bag type
                  </SelectItem>
                  {bagTypes.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="min-h-10">
                      {b.name} · {displayKg(b.standardKg)} (sack {displayKg(b.sackWeightKg)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <Controller
            name={`lines.${index}.bags`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("bags")}>Bags</FieldLabel>
                <Input
                  id={fid("bags")}
                  {...field}
                  className="h-12 text-lg"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name={`lines.${index}.grossKg`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("gross")}>Gross kg</FieldLabel>
                <Input
                  id={fid("gross")}
                  {...field}
                  className="h-12 text-lg"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.0"
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Controller
            name={`lines.${index}.priceNaira`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("price")}>Price ₦/kg</FieldLabel>
                <Input
                  id={fid("price")}
                  {...field}
                  className="h-12 text-lg"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  aria-invalid={fieldState.invalid || overGuide || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name={`lines.${index}.moisturePercent`}
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={fid("moisture")}>Moisture %</FieldLabel>
                <Input
                  id={fid("moisture")}
                  {...field}
                  className="h-12 text-lg"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="optional"
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
        <GuideHint guide={guide} overGuide={!!overGuide} ready={!!commodityId} />

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Deductions</p>
          {deductions.fields.map((d, di) => (
            <div key={d.id} className="flex items-start gap-2">
              <Controller
                name={`lines.${index}.deductions.${di}.reason`}
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="h-12 flex-1" aria-label={`Deduction ${di + 1} reason`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DEDUCTION_REASON_LABELS) as Array<keyof typeof DEDUCTION_REASON_LABELS>).map((r) => (
                        <SelectItem key={r} value={r} className="min-h-10">
                          {DEDUCTION_REASON_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <Controller
                name={`lines.${index}.deductions.${di}.kg`}
                control={control}
                render={({ field, fieldState }) => (
                  <div className="flex w-28 flex-col gap-1">
                    <Input
                      {...field}
                      className="h-12"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="kg"
                      aria-label={`Deduction ${di + 1} kg`}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error ? <span className="text-xs text-destructive">Invalid kg</span> : null}
                  </div>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                className="size-12"
                aria-label={`Remove deduction ${di + 1}`}
                onClick={() => deductions.remove(di)}
              >
                <Trash />
              </Button>
            </div>
          ))}
          {calc.autoSackG > 0 ? (
            <p className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0" />
              Sack weight auto: {calc.bags} bags × {displayKg(calc.sackWeightPerBagKg)} = {displayGrams(calc.autoSackG)}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-12 w-full sm:w-auto sm:self-start"
            disabled={deductions.fields.length >= 10}
            onClick={() => deductions.append({ reason: "moisture", kg: "" })}
          >
            <Plus /> Add deduction
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/60 px-3 py-3" aria-live="polite">
          <div>
            <p className="text-xs text-muted-foreground">Net weight</p>
            <p className="text-lg font-semibold tabular-nums">{calc.netG === null ? "—" : displayGrams(calc.netG)}</p>
            {calc.grossG !== null && calc.netG !== null && calc.grossG !== calc.netG ? (
              <p className="text-xs text-muted-foreground">−{displayGrams(calc.grossG - calc.netG)} deducted</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Line amount</p>
            <p className="text-lg font-semibold tabular-nums">{naira(calc.amountKobo)}</p>
          </div>
          {calc.error ? <p className="col-span-2 text-sm text-destructive">{calc.error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function GuideHint({ guide, overGuide, ready }: { guide: GuideState; overGuide: boolean; ready: boolean }) {
  if (!ready) return null;
  if (guide === undefined) return <p className="-mt-2 text-xs text-muted-foreground">Checking today&apos;s price guide…</p>;
  if (guide === null) return <p className="-mt-2 text-xs text-muted-foreground">No price guide set for this produce.</p>;
  if (overGuide) {
    return (
      <p
        role="status"
        className="-mt-2 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        Above the guide of {nairaPerKg(guide.maxPricePerKgKobo)} — this purchase will need manager approval.
      </p>
    );
  }
  return <p className="-mt-2 text-xs text-muted-foreground">Guide max {nairaPerKg(guide.maxPricePerKgKobo)}</p>;
}
