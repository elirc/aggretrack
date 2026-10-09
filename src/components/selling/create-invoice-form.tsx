"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Receipt } from "lucide-react";
import { toast } from "sonner";

import { createInvoiceFromDispatchAction } from "@/actions/invoices";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { zDateISO } from "@/lib/validation/common";

import { callAction } from "./actions-client";

const schema = z
  .object({
    invoiceDate: zDateISO,
    dueDate: z.union([zDateISO, z.literal("")]),
    applyTax: z.boolean(),
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.invoiceDate, {
    message: "Due date can't be before the invoice date",
    path: ["dueDate"],
  });
type Values = z.infer<typeof schema>;

/** Create an invoice from this dispatch (tax line off by default). */
export function CreateInvoiceForm({ dispatchId, defaultDate }: { dispatchId: string; defaultDate: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { invoiceDate: defaultDate, dueDate: "", applyTax: false },
  });

  const onSubmit = form.handleSubmit((v) =>
    startTransition(async () => {
      const res = await callAction(createInvoiceFromDispatchAction, {
        dispatchId,
        invoiceDate: v.invoiceDate,
        dueDate: v.dueDate || null,
        applyTax: v.applyTax,
      });
      if (res.ok) {
        toast.success(`Invoice ${res.data.invoiceNumber} created`);
        router.push(`/invoices/${res.data.id}`);
      }
    }),
  );

  if (!open) {
    return (
      <Button className="h-11 sm:h-9" onClick={() => setOpen(true)}>
        <Receipt /> Create invoice
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Controller
          name="invoiceDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="inv-date">Invoice date</FieldLabel>
              <Input id="inv-date" type="date" className="h-11" {...field} aria-invalid={fieldState.invalid} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="dueDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="inv-due">Due date (optional)</FieldLabel>
              <Input id="inv-due" type="date" className="h-11" {...field} aria-invalid={fieldState.invalid} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </div>
      <Controller
        name="applyTax"
        control={form.control}
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch id="inv-tax" checked={field.value} onCheckedChange={field.onChange} />
            <div className="flex flex-col">
              <FieldLabel htmlFor="inv-tax">Add tax line</FieldLabel>
              <FieldDescription>Uses the organisation&apos;s tax rate. Off by default.</FieldDescription>
            </div>
          </Field>
        )}
      />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Creating…" : "Create invoice"}
        </Button>
      </div>
    </form>
  );
}
