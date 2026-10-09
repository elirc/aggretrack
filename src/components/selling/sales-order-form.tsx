"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, useWatch, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { confirmSalesOrderAction, createSalesOrderAction } from "@/actions/sales";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { zDateISO, zKgString, zUuid } from "@/lib/validation/common";

import { callAction } from "./actions-client";
import { CustomerSheet } from "./customer-form";
import { gramsOrZero, lineAmount, naira, nairaToKobo } from "./format";

export type Option = { id: string; name: string };
export type GradeOption = { id: string; name: string; commodityId: string };

const pick = (msg: string) => z.string().min(1, msg).pipe(zUuid);

/**
 * Form-side schema: price is typed in naira per kg; transformed to kobo for
 * the server action, which re-validates with salesOrderInput.
 */
const lineSchema = z.object({
  commodityId: pick("Pick a commodity"),
  gradeId: pick("Pick a grade"),
  kg: zKgString.refine((s) => gramsOrZero(s) > 0, "Weight must be greater than 0"),
  priceNaira: z
    .string()
    .trim()
    .refine((s) => nairaToKobo(s) !== null, "Enter a price in naira (up to 2 decimals)"),
});

const formSchema = z.object({
  customerId: pick("Pick a customer"),
  orderDate: zDateISO,
  lines: z.array(lineSchema).min(1, "Add at least one line").max(100),
});
type FormValues = z.infer<typeof formSchema>;

const emptyLine = { commodityId: "", gradeId: "", kg: "", priceNaira: "" };

function LineAmount({ control, index }: { control: Control<FormValues>; index: number }) {
  const line = useWatch({ control, name: `lines.${index}` });
  const amt = lineAmount(gramsOrZero(line?.kg), nairaToKobo(line?.priceNaira) ?? 0);
  return (
    <p className="text-sm">
      Amount <span className="font-semibold tabular-nums">{naira(amt)}</span>
    </p>
  );
}

function OrderTotal({ control }: { control: Control<FormValues> }) {
  const lines = useWatch({ control, name: "lines" });
  const total = (lines ?? []).reduce((s, l) => s + lineAmount(gramsOrZero(l?.kg), nairaToKobo(l?.priceNaira) ?? 0), 0);
  const kgTotal = (lines ?? []).reduce((s, l) => s + gramsOrZero(l?.kg), 0);
  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
      <span className="text-sm text-muted-foreground">
        Total · {(kgTotal / 1000).toLocaleString("en-NG", { maximumFractionDigits: 3 })} kg
      </span>
      <span className="text-lg font-semibold tabular-nums">{naira(total)}</span>
    </div>
  );
}

export function SalesOrderForm({
  customers: initialCustomers,
  commodities,
  grades,
  defaultDate,
  defaultCustomerId,
  canCreateCustomer,
}: {
  customers: Option[];
  commodities: Option[];
  grades: GradeOption[];
  defaultDate: string;
  defaultCustomerId?: string;
  canCreateCustomer: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customers, setCustomers] = useState(initialCustomers);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      customerId: defaultCustomerId && initialCustomers.some((c) => c.id === defaultCustomerId) ? defaultCustomerId : "",
      orderDate: defaultDate,
      lines: [emptyLine],
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });
  const watchedLines = useWatch({ control: form.control, name: "lines" });

  const gradesByCommodity = useMemo(() => {
    const m = new Map<string, GradeOption[]>();
    for (const g of grades) m.set(g.commodityId, [...(m.get(g.commodityId) ?? []), g]);
    return m;
  }, [grades]);

  const submit = (confirm: boolean) =>
    form.handleSubmit((values) => {
      const payload = {
        customerId: values.customerId,
        orderDate: values.orderDate,
        lines: values.lines.map((l) => ({
          commodityId: l.commodityId,
          gradeId: l.gradeId,
          kg: l.kg.trim(),
          pricePerKgKobo: nairaToKobo(l.priceNaira) ?? 0,
        })),
      };
      startTransition(async () => {
        const res = await callAction(createSalesOrderAction, payload);
        if (!res.ok) {
          if (res.fieldErrors) {
            for (const [name, msgs] of Object.entries(res.fieldErrors)) {
              if (msgs?.[0] && (name === "customerId" || name === "orderDate")) {
                form.setError(name, { message: msgs[0] });
              }
            }
          }
          return;
        }
        if (confirm) {
          await callAction(confirmSalesOrderAction, { id: res.data.id }, `Order ${res.data.orderNumber} confirmed`);
        } else {
          toast.success(`Draft ${res.data.orderNumber} saved`);
        }
        router.push(`/sales/${res.data.id}`);
      });
    });

  return (
    <form onSubmit={submit(true)} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          name="customerId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="so-customer">Customer</FieldLabel>
              <div className="flex gap-2">
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="so-customer" className="h-11 w-full min-w-0 flex-1" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder={customers.length ? "Select customer…" : "No customers yet"} />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canCreateCustomer ? (
                  <CustomerSheet
                    title="New customer"
                    refreshOnSave={false}
                    onSaved={(c) => {
                      setCustomers((prev) => [...prev, c].sort((a, b) => a.name.localeCompare(b.name)));
                      form.setValue("customerId", c.id, { shouldValidate: true });
                    }}
                    trigger={
                      <Button type="button" variant="outline" className="h-11 shrink-0" aria-label="New customer">
                        <UserPlus />
                        <span className="hidden sm:inline">New</span>
                      </Button>
                    }
                  />
                ) : null}
              </div>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="orderDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="so-date">Order date</FieldLabel>
              <Input
                id="so-date"
                type="date"
                className="h-11"
                {...field}
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      <section aria-label="Lines" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Lines</h2>
        {fields.map((f, index) => {
          const commodityId = watchedLines?.[index]?.commodityId ?? "";
          const gradeOptions = gradesByCommodity.get(commodityId) ?? [];
          return (
            <Card key={f.id} className="py-3">
              <CardContent className="flex flex-col gap-3 px-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Line {index + 1}</p>
                  {fields.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8"
                      onClick={() => remove(index)}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Controller
                    name={`lines.${index}.commodityId`}
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid || undefined}>
                        <FieldLabel htmlFor={`l${index}-commodity`}>Commodity</FieldLabel>
                        <Select
                          value={field.value}
                          onValueChange={(v) => {
                            field.onChange(v);
                            form.setValue(`lines.${index}.gradeId`, "");
                          }}
                        >
                          <SelectTrigger id={`l${index}-commodity`} className="h-11 w-full" aria-invalid={fieldState.invalid}>
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            {commodities.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
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
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid || undefined}>
                        <FieldLabel htmlFor={`l${index}-grade`}>Grade</FieldLabel>
                        <Select value={field.value} onValueChange={field.onChange} disabled={!commodityId}>
                          <SelectTrigger id={`l${index}-grade`} className="h-11 w-full" aria-invalid={fieldState.invalid}>
                            <SelectValue
                              placeholder={
                                !commodityId ? "Pick commodity first" : gradeOptions.length ? "Select…" : "No grades"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {gradeOptions.map((g) => (
                              <SelectItem key={g.id} value={g.id}>
                                {g.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FieldError errors={[fieldState.error]} />
                      </Field>
                    )}
                  />
                  <Controller
                    name={`lines.${index}.kg`}
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid || undefined}>
                        <FieldLabel htmlFor={`l${index}-kg`}>Weight (kg)</FieldLabel>
                        <Input
                          id={`l${index}-kg`}
                          inputMode="decimal"
                          autoComplete="off"
                          className="h-11"
                          placeholder="0"
                          {...field}
                          aria-invalid={fieldState.invalid}
                        />
                        <FieldError errors={[fieldState.error]} />
                      </Field>
                    )}
                  />
                  <Controller
                    name={`lines.${index}.priceNaira`}
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid || undefined}>
                        <FieldLabel htmlFor={`l${index}-price`}>Price per kg (₦)</FieldLabel>
                        <Input
                          id={`l${index}-price`}
                          inputMode="decimal"
                          autoComplete="off"
                          className="h-11"
                          placeholder="0.00"
                          {...field}
                          aria-invalid={fieldState.invalid}
                        />
                        <FieldError errors={[fieldState.error]} />
                      </Field>
                    )}
                  />
                </div>
                <LineAmount control={form.control} index={index} />
              </CardContent>
            </Card>
          );
        })}
        {form.formState.errors.lines?.root?.message || form.formState.errors.lines?.message ? (
          <p role="alert" className="text-sm text-destructive">
            {form.formState.errors.lines?.root?.message ?? form.formState.errors.lines?.message}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="h-11" onClick={() => append(emptyLine)}>
          <Plus /> Add line
        </Button>
      </section>

      <OrderTotal control={form.control} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 sm:h-9" disabled={pending} onClick={submit(false)}>
          Save as draft
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : "Save & confirm"}
        </Button>
      </div>
    </form>
  );
}
