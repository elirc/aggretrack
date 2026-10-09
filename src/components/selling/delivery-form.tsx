"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PackageCheck } from "lucide-react";

import { recordDeliveryAction } from "@/actions/dispatches";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { kgToGrams } from "@/lib/domain/units";
import { zKgString } from "@/lib/validation/common";

import { callAction } from "./actions-client";
import { gramsToKgInput, kg, kgFromGrams, parseKgInput } from "./format";

/** Delivered-weight entry for an in-transit dispatch, with live transit loss. */
export function DeliveryForm({ dispatchId, dispatchedKg }: { dispatchId: string; dispatchedKg: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const dispatchedG = kgToGrams(dispatchedKg);

  const schema = z.object({
    deliveredKg: zKgString.refine((s) => kgToGrams(s) <= dispatchedG, "Can't exceed the dispatched weight"),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { deliveredKg: gramsToKgInput(dispatchedG) },
  });
  const delivered = useWatch({ control: form.control, name: "deliveredKg" });
  const deliveredG = parseKgInput(delivered);
  const lossG = deliveredG === null ? null : dispatchedG - deliveredG;
  const lossPct = lossG !== null && dispatchedG > 0 ? (lossG / dispatchedG) * 100 : 0;

  const onSubmit = form.handleSubmit((values) =>
    startTransition(async () => {
      const res = await callAction(
        recordDeliveryAction,
        { dispatchId, deliveredKg: values.deliveredKg.trim() },
        "Delivery recorded",
      );
      if (res.ok) router.refresh();
      else if (res.fieldErrors?.deliveredKg?.[0]) form.setError("deliveredKg", { message: res.fieldErrors.deliveredKg[0] });
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <Controller
        name="deliveredKg"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor="dlv-kg">Delivered weight (kg)</FieldLabel>
            <Input
              id="dlv-kg"
              inputMode="decimal"
              autoComplete="off"
              className="h-11"
              {...field}
              aria-invalid={fieldState.invalid}
            />
            <FieldDescription>Total weighed at the customer for this dispatch. Dispatched {kg(dispatchedKg)}.</FieldDescription>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2" aria-live="polite">
        <span className="text-sm text-muted-foreground">Transit loss</span>
        <span
          className={
            lossG !== null && lossG > 0
              ? "font-semibold text-amber-700 tabular-nums dark:text-amber-300"
              : "font-semibold tabular-nums"
          }
        >
          {lossG === null ? "—" : lossG < 0 ? "Over dispatched" : `${kgFromGrams(lossG)} (${lossPct.toFixed(2)}%)`}
        </span>
      </div>
      <Button type="submit" className="h-11" disabled={pending}>
        <PackageCheck /> {pending ? "Saving…" : "Record delivery"}
      </Button>
    </form>
  );
}
