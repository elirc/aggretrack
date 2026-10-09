"use client";

import { useTransition, type ReactNode } from "react";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createSupplierAction, updateSupplierAction } from "@/actions/suppliers";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supplierInput, type SupplierInput } from "@/lib/validation/buying";

import { runBuyingAction } from "./action-result";
import { SUPPLIER_TYPE_LABELS } from "./format";

export type SupplierFormValues = {
  type: "farmer" | "agent" | "cooperative";
  name: string;
  phone: string;
  village: string;
  lga: string;
  state: string;
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
  idNote: string;
  photoKey: string;
};

export const EMPTY_SUPPLIER: SupplierFormValues = {
  type: "farmer",
  name: "",
  phone: "",
  village: "",
  lga: "",
  state: "",
  bankName: "",
  bankAccountNumber: "",
  bankAccountName: "",
  idNote: "",
  photoKey: "",
};

/** Map a stored supplier row (nullable columns) into form values. */
export function supplierToValues(s: {
  type: SupplierFormValues["type"];
  name: string;
  phone: string | null;
  village: string | null;
  lga: string | null;
  state: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  idNote: string | null;
  photoKey: string | null;
}): SupplierFormValues {
  return {
    type: s.type,
    name: s.name,
    phone: s.phone ? (s.phone.startsWith("234") ? `0${s.phone.slice(3)}` : s.phone) : "",
    village: s.village ?? "",
    lga: s.lga ?? "",
    state: s.state ?? "",
    bankName: s.bankName ?? "",
    bankAccountNumber: s.bankAccountNumber ?? "",
    bankAccountName: s.bankAccountName ?? "",
    idNote: s.idNote ?? "",
    photoKey: s.photoKey ?? "",
  };
}

type TextName = Exclude<keyof SupplierFormValues, "type">;

const TEXT_FIELDS: Array<{
  name: TextName;
  label: string;
  inputMode?: "text" | "tel" | "numeric";
  placeholder?: string;
  compact?: boolean;
  description?: string;
}> = [
  { name: "name", label: "Name", compact: true, placeholder: "e.g. Musa Ibrahim" },
  { name: "phone", label: "Phone", inputMode: "tel", compact: true, placeholder: "0803 123 4567", description: "Used for SMS receipts." },
  { name: "village", label: "Village", compact: true },
  { name: "lga", label: "LGA" },
  { name: "state", label: "State" },
  { name: "bankName", label: "Bank" },
  { name: "bankAccountNumber", label: "Account number", inputMode: "numeric", placeholder: "10 digits" },
  { name: "bankAccountName", label: "Account name" },
];

/**
 * Create / edit a supplier. `compact` shows only type, name, phone and village
 * (the inline "add supplier" sheet on the purchase form).
 */
export function SupplierForm({
  supplierId,
  defaultValues = EMPTY_SUPPLIER,
  compact = false,
  submitLabel,
  onSaved,
  secondary,
}: {
  supplierId?: string;
  defaultValues?: SupplierFormValues;
  compact?: boolean;
  submitLabel?: string;
  onSaved?: (s: { id: string; name: string; values: SupplierInput }) => void;
  secondary?: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<SupplierFormValues, unknown, SupplierInput>({
    resolver: zodResolver(supplierInput) as unknown as Resolver<SupplierFormValues, unknown, SupplierInput>,
    defaultValues,
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      if (supplierId) {
        const res = await runBuyingAction(() => updateSupplierAction({ id: supplierId, ...values }), {
          success: "Supplier saved",
        });
        if (res.ok) onSaved?.({ id: supplierId, name: values.name, values });
        else if (res.fieldErrors) applyErrors(res.fieldErrors);
        return;
      }
      const res = await runBuyingAction(() => createSupplierAction(values), {
        success: (d) => `${d.name} added`,
      });
      if (res.ok) {
        form.reset(EMPTY_SUPPLIER);
        onSaved?.({ id: res.data.id, name: res.data.name, values });
      } else if (res.fieldErrors) applyErrors(res.fieldErrors);
    });
  });

  function applyErrors(fieldErrors: Record<string, string[]>) {
    for (const [name, msgs] of Object.entries(fieldErrors)) {
      if (msgs?.[0] && name in EMPTY_SUPPLIER) form.setError(name as keyof SupplierFormValues, { message: msgs[0] });
    }
  }

  const fields = compact ? TEXT_FIELDS.filter((f) => f.compact) : TEXT_FIELDS;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          name="type"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="sup-type">Type</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="sup-type" className="h-12 w-full sm:h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SUPPLIER_TYPE_LABELS) as Array<keyof typeof SUPPLIER_TYPE_LABELS>).map((t) => (
                    <SelectItem key={t} value={t}>
                      {SUPPLIER_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <div className={compact ? "flex flex-col gap-4" : "grid gap-4 sm:grid-cols-2"}>
          {fields.map((spec) => (
            <Controller
              key={spec.name}
              name={spec.name}
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor={`sup-${spec.name}`}>{spec.label}</FieldLabel>
                  <Input
                    id={`sup-${spec.name}`}
                    {...field}
                    className="h-12 sm:h-10"
                    inputMode={spec.inputMode ?? "text"}
                    autoComplete="off"
                    placeholder={spec.placeholder}
                    aria-invalid={fieldState.invalid}
                  />
                  {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          ))}
        </div>
        {compact ? null : (
          <Controller
            name="idNote"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="sup-idNote">ID note</FieldLabel>
                <Textarea id="sup-idNote" {...field} rows={2} placeholder="e.g. NIN or voter card number" />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        )}
      </FieldGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {secondary}
        <Button type="submit" className="h-12 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : (submitLabel ?? (supplierId ? "Save changes" : "Add supplier"))}
        </Button>
      </div>
    </form>
  );
}
