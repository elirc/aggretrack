"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { createPurchaseAction, updatePurchaseAction } from "@/actions/purchases";
import { runBuyingAction } from "@/components/buying/action-result";
import { displayGrams, lagosTodayISO, naira, newUuid } from "@/components/buying/format";
import { calcLine } from "@/components/buying/line-math";
import { SupplierCombobox, type SupplierOption } from "@/components/buying/supplier-combobox";
import { usePriceGuides } from "@/components/buying/use-price-guides";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { LineEditor, type BagTypeOption, type CommodityOption, type GradeOption } from "./line-editor";
import {
  buildPurchaseFormSchema,
  buildPurchasePayload,
  type LineValues,
  type PurchaseFormValues,
} from "./purchase-schema";

export type BuyingPointOption = { id: string; name: string };

const NO_POINT = "__none__";

function emptyLine(commodities: CommodityOption[], grades: GradeOption[]): LineValues {
  // One commodity in the org → preselect it (and its only grade).
  const commodityId = commodities.length === 1 ? commodities[0].id : "";
  const g = grades.filter((x) => x.commodityId === commodityId);
  return {
    id: newUuid(),
    commodityId,
    gradeId: g.length === 1 ? g[0].id : "",
    bagTypeId: "",
    bags: "",
    grossKg: "",
    moisturePercent: "",
    priceNaira: "",
    deductions: [],
  };
}

/**
 * Purchase quick entry (flagship mobile flow). The purchase id is a client
 * UUID generated once at mount, so retrying a save (flaky network) can never
 * create a second purchase — the server returns the stored one as a duplicate.
 * Offline queueing is added in Wave 4 (P4-B) around `buildPurchasePayload`.
 */
export function PurchaseForm({
  suppliers,
  buyingPoints,
  buyingPointRequired,
  commodities,
  grades,
  bagTypes,
  canCreateSupplier,
  initialSupplierId,
  existing,
}: {
  suppliers: SupplierOption[];
  buyingPoints: BuyingPointOption[];
  buyingPointRequired: boolean;
  commodities: CommodityOption[];
  grades: GradeOption[];
  bagTypes: BagTypeOption[];
  canCreateSupplier: boolean;
  initialSupplierId?: string;
  /** Edit mode: an existing draft / pending purchase (its lines are replaced on save). */
  existing?: { id: string; values: PurchaseFormValues };
}) {
  const router = useRouter();
  const [purchaseId] = useState(() => existing?.id ?? newUuid());
  const [pending, startTransition] = useTransition();

  const sackWeightByBagType = useMemo(
    () => new Map(bagTypes.map((b) => [b.id, b.sackWeightKg] as const)),
    [bagTypes],
  );
  const schema = useMemo(
    () => buildPurchaseFormSchema({ buyingPointRequired, sackWeightByBagType }),
    [buyingPointRequired, sackWeightByBagType],
  );

  const form = useForm<PurchaseFormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<PurchaseFormValues>,
    defaultValues: existing?.values ?? {
      supplierId: initialSupplierId ?? "",
      buyingPointId: buyingPoints.length === 1 ? buyingPoints[0].id : "",
      purchaseDate: lagosTodayISO(),
      lines: [emptyLine(commodities, grades)],
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const watchedLines = useWatch({ control: form.control, name: "lines" });
  const buyingPointId = useWatch({ control: form.control, name: "buyingPointId" });
  const purchaseDate = useWatch({ control: form.control, name: "purchaseDate" });

  const calcs = (watchedLines ?? []).map((l) => calcLine(l, sackWeightByBagType));
  const guideFor = usePriceGuides(
    (watchedLines ?? []).map((l) => ({
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      buyingPointId: buyingPointId ?? "",
      date: purchaseDate ?? "",
    })),
  );
  const guides = (watchedLines ?? []).map((l) =>
    guideFor({ commodityId: l.commodityId, gradeId: l.gradeId, buyingPointId: buyingPointId ?? "", date: purchaseDate ?? "" }),
  );

  const totalNetG = calcs.reduce((s, c) => s + (c.netG ?? 0), 0);
  const totalKobo = calcs.reduce((s, c) => s + (c.amountKobo ?? 0), 0);
  const overGuideCount = calcs.filter((c, i) => {
    const g = guides[i];
    return g && c.priceKobo !== null && c.priceKobo > g.maxPricePerKgKobo;
  }).length;

  const submit = (saveAsDraft: boolean) =>
    form.handleSubmit(
      (values) => {
        const payload = buildPurchasePayload(purchaseId, values, saveAsDraft);
        startTransition(async () => {
          if (existing) {
            const upd = await runBuyingAction(() =>
              updatePurchaseAction({
                id: existing.id,
                supplierId: payload.supplierId,
                buyingPointId: payload.buyingPointId,
                purchaseDate: payload.purchaseDate,
                lines: payload.lines,
                saveAsDraft,
              }),
            );
            if (!upd.ok) return;
            if (upd.data.status === "pending_approval") toast.warning("Saved — price over guide, waiting for approval");
            else if (upd.data.status === "draft") toast.success("Draft saved");
            else toast.success("Purchase saved and approved");
            router.push(`/purchases/${existing.id}`);
            router.refresh();
            return;
          }
          const res = await runBuyingAction(() => createPurchaseAction(payload));
          if (!res.ok) return; // id is kept → retrying is idempotent
          const d = res.data;
          if (d.duplicate) toast.info(`${d.purchaseNumber ?? "Purchase"} was already saved`);
          else if (d.status === "draft") toast.success(`${d.purchaseNumber ?? "Purchase"} saved as draft`);
          else if (d.status === "pending_approval")
            toast.warning(`${d.purchaseNumber ?? "Purchase"} saved — price over guide, waiting for approval`);
          else toast.success(`${d.purchaseNumber ?? "Purchase"} saved · ${naira(d.totalAmountKobo)}`);
          router.push(`/purchases/${d.id}`);
        });
      },
      () => toast.error("Please fix the highlighted fields."),
    );

  return (
    <form noValidate onSubmit={(e) => void submit(false)(e)} className="flex flex-col gap-4">
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-4 px-3 py-4 sm:px-4">
          <Controller
            name="supplierId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="p-supplier">Supplier</FieldLabel>
                <SupplierCombobox
                  id="p-supplier"
                  options={suppliers}
                  value={field.value}
                  onChange={(id) => field.onChange(id)}
                  allowCreate={canCreateSupplier}
                  invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {buyingPoints.length > 0 ? (
              <Controller
                name="buyingPointId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="p-point">Buying point</FieldLabel>
                    <Select
                      value={field.value || NO_POINT}
                      onValueChange={(v) => field.onChange(v === NO_POINT ? "" : v)}
                    >
                      <SelectTrigger id="p-point" className="h-12 w-full" aria-invalid={fieldState.invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {buyingPointRequired ? null : (
                          <SelectItem value={NO_POINT} className="min-h-10">
                            No buying point
                          </SelectItem>
                        )}
                        {buyingPointRequired && !field.value ? (
                          <SelectItem value={NO_POINT} disabled className="min-h-10">
                            Pick your buying point
                          </SelectItem>
                        ) : null}
                        {buyingPoints.map((b) => (
                          <SelectItem key={b.id} value={b.id} className="min-h-10">
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            ) : null}
            <Controller
              name="purchaseDate"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="p-date">Date</FieldLabel>
                  <Input id="p-date" type="date" {...field} className="h-12" aria-invalid={fieldState.invalid} />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </div>
        </CardContent>
      </Card>

      {lines.fields.map((f, i) => (
        <LineEditor
          key={f.id}
          index={i}
          control={form.control}
          setValue={form.setValue}
          commodities={commodities}
          grades={grades}
          bagTypes={bagTypes}
          commodityId={watchedLines?.[i]?.commodityId ?? ""}
          calc={calcs[i] ?? calcLine(f, sackWeightByBagType)}
          guide={guides[i]}
          canRemove={lines.fields.length > 1}
          onRemove={() => lines.remove(i)}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        className="h-12 border-dashed"
        disabled={lines.fields.length >= 50}
        onClick={() => {
          // Repeat the previous line's produce + bag type: the common case is several lots of the same crop.
          const prev = watchedLines?.[watchedLines.length - 1];
          const next = emptyLine(commodities, grades);
          if (prev) {
            next.commodityId = prev.commodityId;
            next.gradeId = prev.gradeId;
            next.bagTypeId = prev.bagTypeId;
            next.priceNaira = prev.priceNaira;
          }
          lines.append(next);
        }}
      >
        <Plus /> Add another line
      </Button>
      {form.formState.errors.lines?.root?.message || form.formState.errors.lines?.message ? (
        <p className="text-sm text-destructive">
          {form.formState.errors.lines?.root?.message ?? form.formState.errors.lines?.message}
        </p>
      ) : null}

      {/* Sticky save bar — sits above the fixed bottom nav (h-16). */}
      <div className="sticky bottom-16 z-30 -mx-4 mt-2 border-t bg-background/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur">
        <div className="mb-2 flex items-end justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">
              {lines.fields.length} line{lines.fields.length === 1 ? "" : "s"} · {displayGrams(totalNetG)} net
            </p>
            {overGuideCount > 0 ? (
              <p className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                <TriangleAlert className="size-3.5" /> {overGuideCount} over guide — needs approval
              </p>
            ) : null}
          </div>
          <p className="text-xl font-semibold tabular-nums" aria-live="polite">
            {naira(totalKobo)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 sm:flex-none"
            disabled={pending}
            onClick={(e) => void submit(true)(e)}
          >
            Save draft
          </Button>
          <Button type="submit" className="h-12 flex-[2] text-base sm:flex-none" disabled={pending}>
            {pending ? "Saving…" : overGuideCount > 0 ? "Submit for approval" : "Save purchase"}
          </Button>
        </div>
      </div>
    </form>
  );
}
