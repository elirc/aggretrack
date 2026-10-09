"use client";

import { useTransition, type ReactNode } from "react";
import { Controller, useForm, useWatch, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { createExpenseAction, updateExpenseAction } from "@/actions/expenses";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { expenseInput } from "@/lib/validation/logistics";

import { SelectField, TextField, type Option } from "./fields";
import { actionErrorMessage } from "./run-action";
import { nairaToKobo } from "./utils";

export type AttachKind = "none" | "lot" | "trip" | "warehouse";

export type ExpenseFormValues = {
  categoryId: string;
  amountNaira: string;
  expenseDate: string;
  attach: AttachKind;
  targetId: string;
  note: string;
};

export type ExpenseOptions = {
  categories: (Option & { affectsLandedCost: boolean })[];
  lots: Option[];
  trips: (Option & { direction: "inbound" | "outbound" })[];
  warehouses: Option[];
};

const FIELD_FOR: Record<string, keyof ExpenseFormValues> = {
  amountKobo: "amountNaira",
  lotId: "targetId",
  tripId: "targetId",
  warehouseId: "targetId",
};

const ATTACH_LABEL: Record<AttachKind, string> = {
  none: "Not attached",
  lot: "Lot",
  trip: "Trip",
  warehouse: "Warehouse",
};

function toPayload(v: ExpenseFormValues) {
  const target = v.targetId || null;
  return {
    categoryId: v.categoryId,
    amountKobo: nairaToKobo(v.amountNaira) ?? -1,
    expenseDate: v.expenseDate,
    lotId: v.attach === "lot" ? target : null,
    tripId: v.attach === "trip" ? target : null,
    warehouseId: v.attach === "warehouse" ? target : null,
    note: v.note,
  };
}

/** UI strings → payload → the SAME shared expenseInput schema (incl. the one-attachment rule). */
const expenseFormSchema = z
  .object({
    categoryId: z.string().min(1, "Pick a category"),
    amountNaira: z.string(),
    expenseDate: z.string(),
    attach: z.enum(["none", "lot", "trip", "warehouse"]),
    targetId: z.string(),
    note: z.string(),
  })
  .superRefine((v, ctx) => {
    if (nairaToKobo(v.amountNaira) === null) {
      ctx.addIssue({ code: "custom", path: ["amountNaira"], message: "Enter an amount in naira, e.g. 15000" });
    }
    if (v.attach !== "none" && !v.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: `Pick the ${v.attach} this expense belongs to` });
    }
    const r = expenseInput.safeParse(toPayload(v));
    if (!r.success) {
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? "note");
        if (key === "amountKobo" && nairaToKobo(v.amountNaira) === null) continue; // already reported
        if (key === "categoryId" && !v.categoryId) continue;
        ctx.addIssue({ code: "custom", path: [FIELD_FOR[key] ?? key], message: issue.message });
      }
    }
  });

export function ExpenseForm({
  expenseId,
  defaults,
  options,
  onDone,
  secondary,
}: {
  /** Present → edit. */
  expenseId?: string;
  defaults: ExpenseFormValues;
  options: ExpenseOptions;
  onDone: () => void;
  secondary?: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<ExpenseFormValues>({ resolver: zodResolver(expenseFormSchema), defaultValues: defaults });
  const attach = useWatch({ control: form.control, name: "attach" });
  const categoryId = useWatch({ control: form.control, name: "categoryId" });
  const targetId = useWatch({ control: form.control, name: "targetId" });
  const category = options.categories.find((c) => c.value === categoryId);
  const trip = attach === "trip" ? options.trips.find((t) => t.value === targetId) : undefined;

  const landedHint = !category?.affectsLandedCost
    ? null
    : attach === "lot" || (attach === "trip" && trip?.direction === "inbound")
      ? "This category adds to landed cost of the attached lot(s)."
      : attach === "trip" && trip?.direction === "outbound"
        ? "Outbound trip — recorded as a delivery cost, not landed cost."
        : null;

  const targetOptions: Option[] =
    attach === "lot"
      ? options.lots
      : attach === "trip"
        ? options.trips
        : attach === "warehouse"
          ? options.warehouses
          : [];

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const payload = toPayload(values);
      try {
        const res = expenseId
          ? await updateExpenseAction({ ...payload, id: expenseId })
          : await createExpenseAction(payload);
        if (!res.ok) {
          for (const [name, msgs] of Object.entries(res.fieldErrors ?? {})) {
            const field = (FIELD_FOR[name] ?? name) as Path<ExpenseFormValues>;
            if (msgs?.[0]) form.setError(field, { message: msgs[0] });
          }
          toast.error(actionErrorMessage(res.error));
          return;
        }
        toast.success(
          expenseId ? "Expense saved" : `Expense ${(res.data as { expenseNumber?: string }).expenseNumber ?? ""} recorded`,
        );
        onDone();
      } catch {
        toast.error(actionErrorMessage("INTERNAL"));
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <SelectField
          control={form.control}
          name="categoryId"
          label="Category"
          options={options.categories}
          placeholder="Pick a category"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField control={form.control} name="amountNaira" label="Amount (₦)" inputMode="decimal" placeholder="0" />
          <TextField control={form.control} name="expenseDate" label="Date" type="date" />
        </div>
        <Controller
          control={form.control}
          name="attach"
          render={({ field }) => (
            <Field>
              <FieldLabel>Attach to</FieldLabel>
              <RadioGroup
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v as AttachKind);
                  form.setValue("targetId", "");
                  form.clearErrors("targetId");
                }}
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
              >
                {(Object.keys(ATTACH_LABEL) as AttachKind[]).map((k) => (
                  <label
                    key={k}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-data-checked:border-primary"
                  >
                    <RadioGroupItem value={k} />
                    {ATTACH_LABEL[k]}
                  </label>
                ))}
              </RadioGroup>
              <FieldDescription>At most one of lot, trip or warehouse.</FieldDescription>
            </Field>
          )}
        />
        {attach !== "none" ? (
          <SelectField
            key={attach}
            control={form.control}
            name="targetId"
            label={ATTACH_LABEL[attach]}
            options={targetOptions}
            placeholder={targetOptions.length === 0 ? `No ${attach}s available` : `Pick a ${attach}`}
          />
        ) : (
          <Controller control={form.control} name="targetId" render={({ fieldState }) => <FieldError errors={[fieldState.error]} />} />
        )}
        {landedHint ? <p className="text-xs text-muted-foreground">{landedHint}</p> : null}
        <TextField control={form.control} name="note" label="Note" multiline />
      </FieldGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {secondary}
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : expenseId ? "Save changes" : "Record expense"}
        </Button>
      </div>
    </form>
  );
}
