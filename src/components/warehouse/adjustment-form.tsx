"use client";

import { useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createAdjustmentAction } from "@/actions/adjustments";
import { zKgString, zUuid } from "@/lib/validation/common";
import { MANUAL_ADJUSTMENT_REASONS, type CreateAdjustmentInput } from "@/lib/validation/warehouse";

import { ADJUSTMENT_REASON_LABEL, fmtBags, fmtGrams, fmtSignedGrams, tryGrams } from "./format";
import { lotOptionLabel, type LotsByWarehouse } from "./position";
import { runWarehouseAction } from "./run-action";

const NO_BIN = "__none";

const formSchema = z.object({
  warehouseId: zUuid,
  lotId: zUuid,
  reason: z.enum(MANUAL_ADJUSTMENT_REASONS),
  direction: z.enum(["remove", "add"]),
  kg: zKgString.refine((s) => Number(s) > 0, "Must be more than 0 kg"),
  bags: z.string().trim().regex(/^\d*$/, "Whole bags only"),
  binId: z.string(),
  note: z.string().trim().max(500, "Too long"),
});
type FormValues = z.infer<typeof formSchema>;

type WarehouseOpt = { id: string; name: string; bins: { id: string; name: string }[] };

/** Manual adjustment: warehouse → lot → reason, direction, kg/bags. Approval rule applied server-side. */
export function AdjustmentForm({
  warehouses,
  lots,
  thresholdGrams,
  initialWarehouseId,
  initialLotId,
}: {
  warehouses: WarehouseOpt[];
  lots: LotsByWarehouse;
  thresholdGrams: number;
  initialWarehouseId?: string;
  initialLotId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const startWh = initialWarehouseId ?? (warehouses.length === 1 ? warehouses[0].id : "");
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      warehouseId: startWh,
      lotId: initialLotId && (lots[startWh] ?? []).some((l) => l.lotId === initialLotId) ? initialLotId : "",
      reason: "shrinkage",
      direction: "remove",
      kg: "",
      bags: "",
      binId: NO_BIN,
      note: "",
    },
  });
  const warehouseId = useWatch({ control: form.control, name: "warehouseId" });
  const lotId = useWatch({ control: form.control, name: "lotId" });
  const direction = useWatch({ control: form.control, name: "direction" });
  const kg = useWatch({ control: form.control, name: "kg" });

  const whLots = useMemo(() => (warehouseId ? (lots[warehouseId] ?? []) : []), [warehouseId, lots]);
  const lot = whLots.find((l) => l.lotId === lotId);
  const bins = warehouses.find((w) => w.id === warehouseId)?.bins ?? [];
  const g = tryGrams(kg);
  const signed = g === null ? null : direction === "remove" ? -g : g;
  const needsApproval = g !== null && g > thresholdGrams;
  const tooMuch = lot && g !== null && direction === "remove" && g > lot.grams;

  const onSubmit = form.handleSubmit((v) => {
    if (tooMuch) {
      form.setError("kg", { message: `Only ${fmtGrams(lot.grams)} on hand` });
      return;
    }
    const bagsN = v.bags === "" ? 0 : Number(v.bags);
    const payload: CreateAdjustmentInput = {
      warehouseId: v.warehouseId,
      lotId: v.lotId,
      binId: v.binId === NO_BIN ? null : v.binId,
      reason: v.reason,
      kg: v.direction === "remove" ? `-${v.kg}` : v.kg,
      bags: v.direction === "remove" ? -bagsN : bagsN,
      note: v.note || null,
    };
    startTransition(async () => {
      const res = await runWarehouseAction(createAdjustmentAction, payload);
      if (res.ok) {
        toast.success(
          res.data.status === "posted"
            ? `${res.data.adjustmentNumber} posted`
            : `${res.data.adjustmentNumber} sent for approval`,
        );
        router.push(`/adjustments/${res.data.id}`);
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Controller
          name="warehouseId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="adj-wh">Warehouse</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v);
                  form.setValue("lotId", "");
                  form.setValue("binId", NO_BIN);
                }}
              >
                <SelectTrigger id="adj-wh" className="h-11 w-full" aria-invalid={fieldState.invalid}>
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
        <Controller
          name="lotId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="adj-lot">Lot</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={!warehouseId}>
                <SelectTrigger id="adj-lot" className="h-11 w-full" aria-invalid={fieldState.invalid}>
                  <SelectValue placeholder={whLots.length ? "Choose lot…" : "No stock here"} />
                </SelectTrigger>
                <SelectContent>
                  {whLots.map((l) => (
                    <SelectItem key={l.lotId} value={l.lotId}>
                      {lotOptionLabel(l)} · {fmtGrams(l.grams)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {lot ? (
                <FieldDescription>
                  On hand {fmtGrams(lot.grams)} · {fmtBags(lot.bags)}
                </FieldDescription>
              ) : null}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="reason"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="adj-reason">Reason</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="adj-reason" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_ADJUSTMENT_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ADJUSTMENT_REASON_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Controller
          name="direction"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel>Direction</FieldLabel>
              <RadioGroup value={field.value} onValueChange={field.onChange} className="grid grid-cols-2 gap-2">
                {(["remove", "add"] as const).map((d) => (
                  <label
                    key={d}
                    htmlFor={`adj-dir-${d}`}
                    className="flex h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[[data-state=checked]]:border-primary"
                  >
                    <RadioGroupItem id={`adj-dir-${d}`} value={d} />
                    {d === "remove" ? "Remove stock" : "Add stock"}
                  </label>
                ))}
              </RadioGroup>
            </Field>
          )}
        />
        <div className="grid grid-cols-2 gap-3">
          <Controller
            name="kg"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || tooMuch || undefined}>
                <FieldLabel htmlFor="adj-kg">Kg</FieldLabel>
                <Input id="adj-kg" {...field} inputMode="decimal" autoComplete="off" className="h-11" />
                <FieldError
                  errors={[fieldState.error ?? (tooMuch && lot ? { message: `Only ${fmtGrams(lot.grams)} on hand` } : undefined)]}
                />
              </Field>
            )}
          />
          <Controller
            name="bags"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="adj-bags">Bags</FieldLabel>
                <Input id="adj-bags" {...field} inputMode="numeric" autoComplete="off" className="h-11" />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
        {bins.length > 0 ? (
          <Controller
            name="binId"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="adj-bin">Bin (optional)</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="adj-bin" className="h-11 w-full">
                    <SelectValue />
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
        <Controller
          name="note"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="adj-note">Note (optional)</FieldLabel>
              <Textarea id="adj-note" {...field} rows={2} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      {signed !== null && signed !== 0 ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          Change <span className="font-medium tabular-nums">{fmtSignedGrams(signed)}</span> —{" "}
          {needsApproval
            ? `over the ${fmtGrams(thresholdGrams)} limit, so it waits for approval.`
            : "within the limit, so it posts immediately."}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => router.push("/adjustments")}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : "Save adjustment"}
        </Button>
      </div>
    </form>
  );
}
