"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { recordCustomerPaymentAction } from "@/actions/customer-payments";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { zDateISO, zUuid } from "@/lib/validation/common";

import { callAction } from "./actions-client";
import { dateOnly, koboToNairaInput, naira, nairaToKobo } from "./format";

export type OpenInvoice = {
  id: string;
  customerId: string;
  invoiceNumber: string;
  invoiceDate: string;
  outstandingKobo: number;
};

const formSchema = z.object({
  customerId: z.string().min(1, "Pick a customer").pipe(zUuid),
  amountNaira: z
    .string()
    .trim()
    .refine((s) => (nairaToKobo(s) ?? 0) > 0, "Enter an amount in naira greater than 0"),
  method: z.enum(["cash", "transfer", "pos"]),
  paymentDate: zDateISO,
  reference: z.string().trim().max(200),
  note: z.string().trim().max(1000),
});
type Values = z.infer<typeof formSchema>;

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "pos", label: "POS" },
] as const;

/** Record a customer payment; allocate FIFO (default) or by hand per open invoice. */
export function PaymentForm({
  customers,
  openInvoices,
  defaultCustomerId,
  defaultDate,
}: {
  customers: { id: string; name: string }[];
  openInvoices: OpenInvoice[];
  defaultCustomerId?: string;
  defaultDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [auto, setAuto] = useState(true);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [manualError, setManualError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      customerId: defaultCustomerId && customers.some((c) => c.id === defaultCustomerId) ? defaultCustomerId : "",
      amountNaira: "",
      method: "transfer",
      paymentDate: defaultDate,
      reference: "",
      note: "",
    },
  });
  const customerId = useWatch({ control: form.control, name: "customerId" });
  const amountNaira = useWatch({ control: form.control, name: "amountNaira" });
  const amountKobo = nairaToKobo(amountNaira) ?? 0;

  const invoices = useMemo(
    () =>
      openInvoices
        .filter((i) => i.customerId === customerId && i.outstandingKobo > 0)
        .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber)),
    [openInvoices, customerId],
  );
  const totalOutstanding = invoices.reduce((s, i) => s + i.outstandingKobo, 0);

  // FIFO preview (mirrors the service: oldest invoice first).
  const fifoPreview = useMemo(() => {
    let left = amountKobo;
    const out = new Map<string, number>();
    for (const i of invoices) {
      if (left <= 0) break;
      const take = Math.min(left, i.outstandingKobo);
      out.set(i.id, take);
      left -= take;
    }
    return { map: out, unallocated: Math.max(0, left) };
  }, [invoices, amountKobo]);

  let manualSum = 0;
  let manualInvalid = false;
  const rowErr: Record<string, string> = {};
  for (const i of invoices) {
    const raw = manual[i.id];
    if (!raw || raw.trim() === "") continue;
    const k = nairaToKobo(raw);
    if (k === null) {
      rowErr[i.id] = "Enter naira (up to 2 decimals)";
      manualInvalid = true;
      continue;
    }
    if (k > i.outstandingKobo) {
      rowErr[i.id] = "More than outstanding";
      manualInvalid = true;
    }
    manualSum += k;
  }
  const manualOver = manualSum > amountKobo;

  const onSubmit = form.handleSubmit((v) => {
    setManualError(null);
    let allocations: { invoiceId: string; amountKobo: number }[] | undefined;
    if (!auto) {
      if (manualInvalid) {
        setManualError("Fix the highlighted invoice amounts.");
        return;
      }
      if (manualOver) {
        setManualError("Allocations exceed the payment amount.");
        return;
      }
      allocations = invoices
        .map((i) => ({ invoiceId: i.id, amountKobo: nairaToKobo(manual[i.id]) ?? 0 }))
        .filter((a) => a.amountKobo > 0);
      // An empty manual split would silently fall back to FIFO server-side; ask instead.
      if (allocations.length === 0 && invoices.length > 0) {
        setManualError("Enter an amount against at least one invoice, or switch on auto-allocate.");
        return;
      }
      if (allocations.length === 0) allocations = undefined;
    }
    startTransition(async () => {
      const res = await callAction(recordCustomerPaymentAction, {
        customerId: v.customerId,
        amountKobo: nairaToKobo(v.amountNaira) ?? 0,
        method: v.method,
        paymentDate: v.paymentDate,
        reference: v.reference || null,
        note: v.note || null,
        allocations,
      });
      if (res.ok) {
        toast.success(
          res.data.unallocatedKobo > 0
            ? `Payment ${res.data.paymentNumber} recorded · ${naira(res.data.unallocatedKobo)} held as credit`
            : `Payment ${res.data.paymentNumber} recorded`,
        );
        form.reset({ ...v, amountNaira: "", reference: "", note: "" });
        setManual({});
        router.refresh();
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          name="customerId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="pay-customer">Customer</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v);
                  setManual({});
                }}
              >
                <SelectTrigger id="pay-customer" className="h-11 w-full" aria-invalid={fieldState.invalid}>
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
              {customerId ? (
                <FieldDescription>
                  {invoices.length} open invoice{invoices.length === 1 ? "" : "s"} · {naira(totalOutstanding)} outstanding
                </FieldDescription>
              ) : null}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Controller
            name="amountNaira"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="pay-amount">Amount (₦)</FieldLabel>
                <Input
                  id="pay-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  className="h-11"
                  {...field}
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="method"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="pay-method">Method</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="pay-method" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          <Controller
            name="paymentDate"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="pay-date">Payment date</FieldLabel>
                <Input id="pay-date" type="date" className="h-11" {...field} aria-invalid={fieldState.invalid} />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="reference"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="pay-ref">Reference (optional)</FieldLabel>
                <Input id="pay-ref" autoComplete="off" className="h-11" {...field} placeholder="Teller / transfer ref" />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
        <Controller
          name="note"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="pay-note">Note (optional)</FieldLabel>
              <Textarea id="pay-note" rows={2} {...field} />
            </Field>
          )}
        />
      </FieldGroup>

      <Field orientation="horizontal">
        <Switch id="pay-auto" checked={auto} onCheckedChange={setAuto} />
        <div className="flex flex-col">
          <FieldLabel htmlFor="pay-auto">Auto-allocate oldest invoice first</FieldLabel>
          <FieldDescription>Turn off to split the payment across invoices yourself.</FieldDescription>
        </div>
      </Field>

      {customerId ? (
        invoices.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            No open invoices — the whole payment is held as credit on the account.
          </p>
        ) : (
          <div className="rounded-lg border">
            <ul className="divide-y">
              {invoices.map((i) => {
                const preview = fifoPreview.map.get(i.id) ?? 0;
                return (
                  <li key={i.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{i.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {dateOnly(i.invoiceDate)} · owes {naira(i.outstandingKobo)}
                      </p>
                    </div>
                    {auto ? (
                      <span className="text-sm tabular-nums">{preview > 0 ? naira(preview) : "—"}</span>
                    ) : (
                      <div className="flex flex-col gap-1 sm:items-end">
                        <div className="flex gap-2">
                          <Input
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="₦0.00"
                            className="h-11 w-full sm:w-36"
                            value={manual[i.id] ?? ""}
                            onChange={(e) => setManual((m) => ({ ...m, [i.id]: e.target.value }))}
                            aria-label={`Amount for ${i.invoiceNumber}`}
                            aria-invalid={!!rowErr[i.id]}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-11 shrink-0"
                            onClick={() => {
                              const others = manualSum - (nairaToKobo(manual[i.id]) ?? 0);
                              const room = Math.max(0, Math.min(i.outstandingKobo, amountKobo - others));
                              setManual((m) => ({ ...m, [i.id]: room > 0 ? koboToNairaInput(room) : "" }));
                            }}
                          >
                            Fill
                          </Button>
                        </div>
                        {rowErr[i.id] ? <p className="text-xs text-destructive">{rowErr[i.id]}</p> : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">{auto ? "Held as credit" : "Allocated / unallocated"}</span>
              <span className={!auto && manualOver ? "font-semibold text-destructive tabular-nums" : "font-semibold tabular-nums"}>
                {auto
                  ? naira(fifoPreview.unallocated)
                  : `${naira(manualSum)} / ${naira(Math.max(0, amountKobo - manualSum))}`}
              </span>
            </div>
          </div>
        )
      ) : null}

      {manualError ? (
        <p role="alert" className="text-sm text-destructive">
          {manualError}
        </p>
      ) : null}

      <Button type="submit" className="h-11" disabled={pending}>
        {pending ? "Recording…" : `Record payment${amountKobo > 0 ? ` of ${naira(amountKobo)}` : ""}`}
      </Button>
    </form>
  );
}
