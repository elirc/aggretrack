"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { getAdvancesForSupplierAction } from "@/actions/advances";
import { listPayablesAction, recordSupplierPaymentAction } from "@/actions/supplier-payments";
import { OffsetAdvanceDialog } from "@/components/buying/advance-dialogs";
import { runBuyingAction } from "@/components/buying/action-result";
import {
  displayDate,
  koboToNairaInput,
  lagosTodayISO,
  naira,
  PAYMENT_METHOD_LABELS,
  parseNairaToKobo,
} from "@/components/buying/format";
import { SupplierCombobox, type SupplierOption } from "@/components/buying/supplier-combobox";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { paymentMethodEnum } from "@/lib/validation/buying";
import { zDateISO, zUuid } from "@/lib/validation/common";
import { cn } from "@/lib/utils";

const schema = z.object({
  supplierId: z.string().refine((s) => zUuid.safeParse(s).success, "Pick a supplier"),
  amountNaira: z.string().refine((s) => (parseNairaToKobo(s) ?? 0) > 0, "Enter the amount paid"),
  method: paymentMethodEnum,
  paymentDate: zDateISO,
  reference: z.string().max(200),
  note: z.string().max(500),
  fifo: z.boolean(),
  sendSms: z.boolean(),
});
type Values = z.infer<typeof schema>;

type OpenItem = { id: string; purchaseNumber: string | null; purchaseDate: string; outstandingKobo: number; ageDays: number };
type OpenAdvance = { id: string; advanceNumber: string; advanceDate: string; outstandingKobo: number };
type Loaded = { supplierId: string; purchases: OpenItem[]; advances: OpenAdvance[]; error?: string };

/** Oldest-first preview mirroring the server's allocatePaymentFifo. */
function fifoPreview(amountKobo: number, items: OpenItem[]): Map<string, number> {
  const out = new Map<string, number>();
  let left = amountKobo;
  for (const it of [...items].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))) {
    if (left <= 0) break;
    const take = Math.min(left, it.outstandingKobo);
    if (take > 0) out.set(it.id, take);
    left -= take;
  }
  return out;
}

export function PaymentForm({
  suppliers,
  initialSupplierId,
  supplierPhones,
  canOffset,
  onDone,
}: {
  suppliers: SupplierOption[];
  initialSupplierId?: string;
  supplierPhones: Record<string, boolean>;
  canOffset: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const defaults: Values = {
    supplierId: initialSupplierId ?? "",
    amountNaira: "",
    method: "cash",
    paymentDate: lagosTodayISO(),
    reference: "",
    note: "",
    fifo: true,
    sendSms: false,
  };
  const form = useForm<Values>({ resolver: zodResolver(schema) as unknown as Resolver<Values>, defaultValues: defaults });
  const supplierId = useWatch({ control: form.control, name: "supplierId" });
  const amountNaira = useWatch({ control: form.control, name: "amountNaira" });
  const fifo = useWatch({ control: form.control, name: "fifo" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!zUuid.safeParse(supplierId).success) return;
    let live = true;
    void (async () => {
      const [p, a] = await Promise.all([
        listPayablesAction({ supplierId }).catch(() => null),
        getAdvancesForSupplierAction({ id: supplierId }).catch(() => null),
      ]);
      if (!live) return;
      setManual({});
      setLoaded({
        supplierId,
        purchases: p && p.ok ? p.data.map((x) => ({ id: x.id, purchaseNumber: x.purchaseNumber, purchaseDate: x.purchaseDate, outstandingKobo: x.outstandingKobo, ageDays: x.ageDays })) : [],
        advances:
          a && a.ok
            ? a.data
                .filter((x) => x.outstandingKobo > 0)
                .map((x) => ({ id: x.id, advanceNumber: x.advanceNumber, advanceDate: x.advanceDate, outstandingKobo: x.outstandingKobo }))
            : [],
        error: !p || !p.ok ? "Couldn't load what is owed to this supplier." : undefined,
      });
    })();
    return () => {
      live = false;
    };
  }, [supplierId, reloadKey]);

  const current = loaded && loaded.supplierId === supplierId ? loaded : null;
  const items = current?.purchases ?? [];
  const totalOutstanding = items.reduce((s, i) => s + i.outstandingKobo, 0);
  const amountKobo = parseNairaToKobo(amountNaira) ?? 0;
  const preview = fifo ? fifoPreview(amountKobo, items) : null;
  const manualKobo = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, v.trim() === "" ? 0 : parseNairaToKobo(v)]));
  const manualSum = Object.values(manualKobo).reduce<number>((s, v) => s + (v ?? 0), 0);
  const manualErrors = new Set(
    items
      .filter((i) => {
        const v = manualKobo[i.id];
        return v === null || (v !== undefined && v > i.outstandingKobo);
      })
      .map((i) => i.id),
  );
  const allocatedPreview = fifo ? [...(preview?.values() ?? [])].reduce((s, v) => s + v, 0) : manualSum;
  const unallocated = Math.max(0, amountKobo - allocatedPreview);
  const manualOver = !fifo && manualSum > amountKobo;

  const onSubmit = form.handleSubmit((v) => {
    if (!fifo) {
      if (manualErrors.size > 0) return void form.setError("amountNaira", { message: "Fix the amounts per purchase" });
      if (manualOver) return void form.setError("amountNaira", { message: "Amounts per purchase add up to more than the payment" });
      if (manualSum <= 0) return void form.setError("amountNaira", { message: "Enter an amount against at least one purchase" });
    }
    const allocations = fifo
      ? []
      : Object.entries(manualKobo)
          .filter(([, k]) => (k ?? 0) > 0)
          .map(([purchaseId, k]) => ({ purchaseId, amountKobo: k as number }));
    startTransition(async () => {
      const res = await runBuyingAction(
        () =>
          recordSupplierPaymentAction({
            supplierId: v.supplierId,
            amountKobo: parseNairaToKobo(v.amountNaira) ?? 0,
            method: v.method,
            paymentDate: v.paymentDate,
            reference: v.reference,
            note: v.note,
            mode: fifo ? "fifo" : "manual",
            allocations,
            sendSms: v.sendSms && !!supplierPhones[v.supplierId],
          }),
        {
          success: (d) =>
            `${d.paymentNumber} recorded${d.unallocatedKobo > 0 ? ` · ${naira(d.unallocatedKobo)} left unallocated` : ""}`,
        },
      );
      if (res.ok) {
        form.reset({ ...defaults, supplierId: v.supplierId });
        setManual({});
        setReloadKey((k) => k + 1);
        router.refresh();
        onDone?.();
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Controller
        name="supplierId"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor="pay-supplier">Supplier</FieldLabel>
            <SupplierCombobox
              id="pay-supplier"
              options={suppliers}
              value={field.value}
              onChange={(id) => field.onChange(id)}
              invalid={fieldState.invalid}
            />
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />

      {zUuid.safeParse(supplierId).success ? (
        current ? (
          <section className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">Unpaid received purchases</p>
              <p className="text-sm tabular-nums">
                Owed <span className="font-semibold">{naira(totalOutstanding)}</span>
              </p>
            </div>
            {current.error ? <p className="text-sm text-destructive">{current.error}</p> : null}
            {items.length === 0 && !current.error ? (
              <p className="text-sm text-muted-foreground">
                Nothing owed on received purchases. A payment now stays on account as credit.
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {items.map((it) => (
                <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
                  <div className="min-w-0">
                    <Link href={`/purchases/${it.id}`} className="text-sm font-medium underline-offset-4 hover:underline">
                      {it.purchaseNumber ?? "Purchase"}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {displayDate(it.purchaseDate)} · {it.ageDays} days · {naira(it.outstandingKobo)} owed
                    </p>
                  </div>
                  {fifo ? (
                    <span className={cn("text-sm tabular-nums", preview?.get(it.id) ? "font-semibold" : "text-muted-foreground")}>
                      {preview?.get(it.id) ? `Pays ${naira(preview.get(it.id) ?? 0)}` : "—"}
                    </span>
                  ) : (
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                      <Input
                        aria-label={`Amount for ${it.purchaseNumber ?? "purchase"}`}
                        className="h-11 sm:w-36"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="₦ 0"
                        value={manual[it.id] ?? ""}
                        aria-invalid={manualErrors.has(it.id) || undefined}
                        onChange={(e) => setManual((m) => ({ ...m, [it.id]: e.target.value }))}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11 shrink-0 sm:h-9"
                        onClick={() => setManual((m) => ({ ...m, [it.id]: koboToNairaInput(it.outstandingKobo) }))}
                      >
                        Full
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {current.advances.length > 0 ? (
              <div className="mt-1 flex flex-col gap-2 border-t pt-2">
                <p className="text-sm font-medium">Advances to recover</p>
                {current.advances.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">
                      {a.advanceNumber} · {displayDate(a.advanceDate)} ·{" "}
                      <span className="font-semibold tabular-nums">{naira(a.outstandingKobo)}</span>
                    </span>
                    {canOffset && items.length > 0 ? (
                      <OffsetAdvanceDialog
                        advance={a}
                        triggerLabel="Offset against purchases"
                        onDone={() => setReloadKey((k) => k + 1)}
                      />
                    ) : null}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Offset an advance first if it should reduce what you pay.</p>
              </div>
            ) : null}
          </section>
        ) : (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            Loading what is owed…
          </p>
        )
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Controller
          name="amountNaira"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pay-amount">Amount paid ₦</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="pay-amount"
                  {...field}
                  className="h-12 text-lg"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={fieldState.invalid}
                />
                {totalOutstanding > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 shrink-0"
                    onClick={() => form.setValue("amountNaira", koboToNairaInput(totalOutstanding), { shouldValidate: true })}
                  >
                    Pay all
                  </Button>
                ) : null}
              </div>
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
                <SelectTrigger id="pay-method" className="h-12 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAYMENT_METHOD_LABELS) as Array<keyof typeof PAYMENT_METHOD_LABELS>).map((m) => (
                    <SelectItem key={m} value={m} className="min-h-10">
                      {PAYMENT_METHOD_LABELS[m]}
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
              <FieldLabel htmlFor="pay-date">Date</FieldLabel>
              <Input id="pay-date" type="date" {...field} className="h-12" aria-invalid={fieldState.invalid} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="reference"
          control={form.control}
          render={({ field }) => (
            <Field className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pay-ref">Reference</FieldLabel>
              <Input id="pay-ref" {...field} className="h-12" autoComplete="off" placeholder="Transfer ref, receipt no." />
            </Field>
          )}
        />
      </div>

      <Controller
        name="fifo"
        control={form.control}
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch id="pay-fifo" checked={field.value} onCheckedChange={field.onChange} />
            <div className="flex flex-col">
              <FieldLabel htmlFor="pay-fifo">Pay oldest purchases first</FieldLabel>
              <FieldDescription>Turn off to enter the amount for each purchase yourself.</FieldDescription>
            </div>
          </Field>
        )}
      />

      {amountKobo > 0 ? (
        <p className={cn("text-sm", manualOver ? "text-destructive" : "text-muted-foreground")}>
          Allocated {naira(allocatedPreview)} of {naira(amountKobo)}
          {unallocated > 0 ? ` · ${naira(unallocated)} stays on account` : ""}
          {manualOver ? " — more than the payment" : ""}
        </p>
      ) : null}

      <Controller
        name="note"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="pay-note">Note</FieldLabel>
            <Textarea id="pay-note" rows={2} {...field} />
          </Field>
        )}
      />

      {supplierPhones[supplierId] ? (
        <Controller
          name="sendSms"
          control={form.control}
          render={({ field }) => (
            <Field orientation="horizontal">
              <Switch id="pay-sms" checked={field.value} onCheckedChange={field.onChange} />
              <div className="flex flex-col">
                <FieldLabel htmlFor="pay-sms">SMS the supplier</FieldLabel>
                <FieldDescription>Amount, method and what is still owed.</FieldDescription>
              </div>
            </Field>
          )}
        />
      ) : null}

      <Button type="submit" className="h-12 text-base sm:h-10 sm:self-end" disabled={pending}>
        {pending ? "Recording…" : "Record payment"}
      </Button>
    </form>
  );
}
