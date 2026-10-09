"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { HandCoins, Plus } from "lucide-react";
import { z } from "zod";

import { createAdvanceAction } from "@/actions/advances";
import { offsetAdvanceAction } from "@/actions/supplier-payments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { zDateISO, zUuid } from "@/lib/validation/common";

import { runBuyingAction } from "./action-result";
import { displayDate, lagosTodayISO, naira, parseNairaToKobo } from "./format";
import { SupplierCombobox, type SupplierOption } from "./supplier-combobox";

const advanceFormSchema = z.object({
  supplierId: z.string().refine((s) => zUuid.safeParse(s).success, "Pick a supplier"),
  amountNaira: z.string().refine((s) => (parseNairaToKobo(s) ?? 0) > 0, "Enter an amount in naira"),
  advanceDate: zDateISO,
  note: z.string().max(500),
});
type AdvanceFormValues = z.infer<typeof advanceFormSchema>;

/** "Record advance" button + dialog. Pass `supplier` to fix the supplier, or `suppliers` to pick one. */
export function RecordAdvanceDialog({
  supplier,
  suppliers = [],
  triggerClassName,
}: {
  supplier?: { id: string; name: string };
  suppliers?: SupplierOption[];
  triggerClassName?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const defaults: AdvanceFormValues = {
    supplierId: supplier?.id ?? "",
    amountNaira: "",
    advanceDate: lagosTodayISO(),
    note: "",
  };
  const form = useForm<AdvanceFormValues>({
    resolver: zodResolver(advanceFormSchema) as unknown as Resolver<AdvanceFormValues>,
    defaultValues: defaults,
  });

  const onSubmit = form.handleSubmit((v) => {
    startTransition(async () => {
      const res = await runBuyingAction(
        () =>
          createAdvanceAction({
            supplierId: v.supplierId,
            amountKobo: parseNairaToKobo(v.amountNaira) ?? 0,
            advanceDate: v.advanceDate,
            note: v.note,
          }),
        { success: (d) => `Advance ${d.advanceNumber} recorded` },
      );
      if (res.ok) {
        setOpen(false);
        form.reset(defaults);
        router.refresh();
      }
    });
  });

  return (
    <>
      <Button className={triggerClassName ?? "h-11 sm:h-9"} onClick={() => setOpen(true)}>
        <Plus /> Record advance
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record advance{supplier ? ` · ${supplier.name}` : ""}</DialogTitle>
            <DialogDescription>Money paid before delivery. It is recovered later against received purchases.</DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
            {supplier ? null : (
              <Controller
                name="supplierId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="adv-supplier">Supplier</FieldLabel>
                    <SupplierCombobox
                      id="adv-supplier"
                      options={suppliers}
                      value={field.value}
                      onChange={(id) => field.onChange(id)}
                      invalid={fieldState.invalid}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="amountNaira"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="adv-amount">Amount ₦</FieldLabel>
                    <Input
                      id="adv-amount"
                      {...field}
                      className="h-12 text-lg"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                name="advanceDate"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="adv-date">Date</FieldLabel>
                    <Input id="adv-date" type="date" {...field} className="h-12" aria-invalid={fieldState.invalid} />
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
                  <FieldLabel htmlFor="adv-note">Note</FieldLabel>
                  <Textarea id="adv-note" rows={2} {...field} placeholder="e.g. Seed money for the season" />
                </Field>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
                {pending ? "Saving…" : "Record advance"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type OffsetAdvanceTarget = {
  id: string;
  advanceNumber: string;
  advanceDate: string;
  outstandingKobo: number;
  supplierName?: string;
};

/**
 * Recover an advance against the supplier's unpaid received purchases
 * (oldest first). Optional cap; blank = the whole outstanding.
 */
export function OffsetAdvanceDialog({
  advance,
  triggerLabel = "Offset",
  triggerVariant = "outline",
  triggerClassName,
  onDone,
}: {
  advance: OffsetAdvanceTarget;
  triggerLabel?: string;
  triggerVariant?: "outline" | "default" | "secondary";
  triggerClassName?: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();
  const capKobo = amount.trim() === "" ? undefined : parseNairaToKobo(amount);
  const invalid = capKobo === null || (capKobo !== undefined && (capKobo <= 0 || capKobo > advance.outstandingKobo));

  return (
    <>
      <Button variant={triggerVariant} className={triggerClassName ?? "h-11 sm:h-8"} onClick={() => setOpen(true)}>
        <HandCoins /> {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Offset {advance.advanceNumber}</DialogTitle>
            <DialogDescription>
              {advance.supplierName ? `${advance.supplierName} · ` : ""}
              {displayDate(advance.advanceDate)} · {naira(advance.outstandingKobo)} outstanding. Recovered against unpaid
              received purchases, oldest first.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={`off-${advance.id}`}>Amount to recover ₦ (optional)</FieldLabel>
            <Input
              id={`off-${advance.id}`}
              className="h-12 text-lg"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              placeholder={`Up to ${naira(advance.outstandingKobo)}`}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={invalid}
            />
            <FieldDescription>Leave blank to recover as much of the outstanding as the purchases cover.</FieldDescription>
            {invalid ? <FieldError>Enter an amount up to {naira(advance.outstandingKobo)}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-11 sm:h-9"
              disabled={pending || invalid}
              onClick={() =>
                startTransition(async () => {
                  const res = await runBuyingAction(
                    () => offsetAdvanceAction({ advanceId: advance.id, amountKobo: capKobo ?? undefined }),
                    {
                      success: (d) =>
                        `Recovered ${naira(d.totalOffsetKobo)} across ${d.offsets.length} purchase${d.offsets.length === 1 ? "" : "s"}`,
                    },
                  );
                  if (res.ok) {
                    setOpen(false);
                    setAmount("");
                    router.refresh();
                    onDone?.();
                  }
                })
              }
            >
              {pending ? "Offsetting…" : "Offset advance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
