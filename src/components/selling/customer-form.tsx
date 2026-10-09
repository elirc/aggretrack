"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { customerInput } from "@/lib/validation/selling";

import { callAction } from "./actions-client";

type FormIn = z.input<typeof customerInput>;
type FormOut = z.output<typeof customerInput>;

export type CustomerFormDefaults = {
  id?: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state?: string | null;
  note?: string | null;
};

const TEXT_FIELDS: { name: keyof FormIn; label: string; inputMode?: "tel" | "email" | "text"; placeholder?: string }[] =
  [
    { name: "name", label: "Name" },
    { name: "phone", label: "Phone", inputMode: "tel", placeholder: "0803 000 0000" },
    { name: "email", label: "Email", inputMode: "email" },
    { name: "address", label: "Address" },
    { name: "state", label: "State", placeholder: "e.g. Kano" },
  ];

/** Create or edit a customer (react-hook-form + the shared customerInput schema). */
export function CustomerForm({
  defaults,
  onSaved,
  submitLabel,
}: {
  defaults?: CustomerFormDefaults;
  onSaved?: (customer: { id: string; name: string }) => void;
  submitLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(customerInput),
    defaultValues: {
      name: defaults?.name ?? "",
      phone: defaults?.phone ?? "",
      email: defaults?.email ?? "",
      address: defaults?.address ?? "",
      state: defaults?.state ?? "",
      note: defaults?.note ?? "",
    },
  });
  const editingId = defaults?.id;

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const res = editingId
        ? await callAction(updateCustomerAction, { ...values, id: editingId }, "Customer updated")
        : await callAction(createCustomerAction, values, "Customer added");
      if (res.ok) {
        onSaved?.({ id: res.data.id, name: values.name });
        if (!editingId) form.reset();
        return;
      }
      if (res.fieldErrors) {
        for (const [name, msgs] of Object.entries(res.fieldErrors)) {
          if (msgs?.[0]) form.setError(name as keyof FormIn, { message: msgs[0] });
        }
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        {TEXT_FIELDS.map((spec) => (
          <Controller
            key={spec.name}
            name={spec.name}
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor={`cust-${spec.name}`}>{spec.label}</FieldLabel>
                <Input
                  id={`cust-${spec.name}`}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  className="h-11"
                  inputMode={spec.inputMode ?? "text"}
                  type={spec.inputMode === "email" ? "email" : spec.inputMode === "tel" ? "tel" : "text"}
                  autoComplete="off"
                  placeholder={spec.placeholder}
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        ))}
        <Controller
          name="note"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="cust-note">Note</FieldLabel>
              <Textarea
                id="cust-note"
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value)}
                rows={3}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" className="h-11" disabled={pending}>
        {pending ? "Saving…" : (submitLabel ?? (editingId ? "Save changes" : "Add customer"))}
      </Button>
    </form>
  );
}

/** A bottom/right sheet wrapping CustomerForm. Used for inline-create and edit. */
export function CustomerSheet({
  trigger,
  title,
  defaults,
  onSaved,
  refreshOnSave = true,
}: {
  trigger: ReactNode;
  title: string;
  defaults?: CustomerFormDefaults;
  onSaved?: (customer: { id: string; name: string }) => void;
  refreshOnSave?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Customers are the buyers you sell produce to.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <CustomerForm
            defaults={defaults}
            onSaved={(c) => {
              setOpen(false);
              onSaved?.(c);
              if (refreshOnSave) router.refresh();
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
