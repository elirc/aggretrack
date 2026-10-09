"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cancelTransferAction, dispatchTransferAction, receiveTransferAction } from "@/actions/transfers";
import { zKgString, zUuid } from "@/lib/validation/common";
import type { ReceiveTransferInput } from "@/lib/validation/warehouse";
import { cn } from "@/lib/utils";

import { fmtGrams, fmtKg, kgInput, tryGrams } from "./format";
import { runWarehouseAction } from "./run-action";

/** Confirm-then-run button for a one-shot transfer action. */
function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  run,
  variant = "default",
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  run: () => Promise<boolean>;
  variant?: "default" | "outline" | "destructive";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button variant={variant} className="h-11 sm:h-9" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const ok = await run();
                  setOpen(false);
                  if (ok) router.refresh();
                });
              }}
            >
              {pending ? "Working…" : confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function DraftTransferActions({
  transferId,
  canDispatch,
  totalLabel,
}: {
  transferId: string;
  canDispatch: boolean;
  totalLabel: string;
}) {
  if (!canDispatch) return null;
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <ConfirmButton
        variant="outline"
        label="Cancel transfer"
        title="Cancel this draft?"
        description="Nothing has moved yet. The draft is kept as cancelled."
        confirmLabel="Cancel transfer"
        run={async () => (await runWarehouseAction(cancelTransferAction, { transferId }, "Transfer cancelled")).ok}
      />
      <ConfirmButton
        label="Dispatch"
        title="Dispatch this transfer?"
        description={`${totalLabel} leaves the source warehouse now and shows as in transit until received.`}
        confirmLabel="Dispatch"
        run={async () => (await runWarehouseAction(dispatchTransferAction, { transferId }, "Transfer dispatched")).ok}
      />
    </div>
  );
}

// ── Receive ──

const receiveForm = z.object({
  lines: z.array(
    z.object({
      lineId: zUuid,
      receivedKg: zKgString,
      receivedBags: z.string().trim().regex(/^\d*$/, "Whole bags only"),
      binId: z.string(),
    }),
  ),
});
type ReceiveForm = z.infer<typeof receiveForm>;

export type ReceiveLine = {
  lineId: string;
  lotLabel: string;
  sentKg: string;
  sentBags: number;
};

const NO_BIN = "__none";

export function ReceiveTransferForm({
  transferId,
  lines,
  bins,
}: {
  transferId: string;
  lines: ReceiveLine[];
  bins: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<ReceiveTransferInput | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<ReceiveForm>({
    resolver: zodResolver(receiveForm),
    defaultValues: {
      lines: lines.map((l) => ({
        lineId: l.lineId,
        receivedKg: kgInput(l.sentKg),
        receivedBags: String(l.sentBags),
        binId: NO_BIN,
      })),
    },
  });
  const fields = useFieldArray({ control: form.control, name: "lines" });
  const watched = useWatch({ control: form.control, name: "lines" });

  const sentG = (i: number) => tryGrams(lines[i]?.sentKg) ?? 0;
  const recvG = (i: number) => tryGrams(watched?.[i]?.receivedKg);
  const lossG = (i: number) => {
    const r = recvG(i);
    return r === null ? null : sentG(i) - r;
  };
  const totalLoss = lines.reduce((s, _l, i) => s + Math.max(0, lossG(i) ?? 0), 0);
  const totalSent = lines.reduce((s, _l, i) => s + sentG(i), 0);

  const onSubmit = form.handleSubmit((values) => {
    let bad = false;
    values.lines.forEach((l, i) => {
      if ((tryGrams(l.receivedKg) ?? 0) > sentG(i)) {
        form.setError(`lines.${i}.receivedKg`, { message: "More than was sent" });
        bad = true;
      }
      if (l.receivedBags !== "" && Number(l.receivedBags) > lines[i].sentBags) {
        form.setError(`lines.${i}.receivedBags`, { message: "More bags than were sent" });
        bad = true;
      }
    });
    if (bad) return;
    setConfirming({
      transferId,
      lines: values.lines.map((l) => ({
        lineId: l.lineId,
        receivedKg: l.receivedKg,
        receivedBags: l.receivedBags === "" ? undefined : Number(l.receivedBags),
        binId: l.binId === NO_BIN ? null : l.binId,
      })),
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {fields.fields.map((f, i) => {
          const loss = lossG(i);
          const over = loss !== null && loss < 0;
          return (
            <li key={f.id} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm">{lines[i].lotLabel}</span>
                <span className="text-xs text-muted-foreground">
                  Sent {fmtKg(lines[i].sentKg)} · {lines[i].sentBags} bags
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Controller
                  name={`lines.${i}.receivedKg`}
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || over || undefined}>
                      <FieldLabel htmlFor={`rcv-kg-${i}`}>Received kg</FieldLabel>
                      <Input
                        id={`rcv-kg-${i}`}
                        {...field}
                        inputMode="decimal"
                        autoComplete="off"
                        className="h-11"
                        aria-invalid={fieldState.invalid || over}
                      />
                      <FieldError errors={[fieldState.error ?? (over ? { message: "More than was sent" } : undefined)]} />
                    </Field>
                  )}
                />
                <Controller
                  name={`lines.${i}.receivedBags`}
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor={`rcv-bags-${i}`}>Bags</FieldLabel>
                      <Input
                        id={`rcv-bags-${i}`}
                        {...field}
                        inputMode="numeric"
                        autoComplete="off"
                        className="h-11"
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
                {bins.length > 0 ? (
                  <Controller
                    name={`lines.${i}.binId`}
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor={`rcv-bin-${i}`}>Bin</FieldLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id={`rcv-bin-${i}`} className="h-11 w-full">
                            <SelectValue placeholder="No bin" />
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
                <div className="flex flex-col justify-end">
                  <span className="text-xs text-muted-foreground">Loss</span>
                  <span
                    className={cn(
                      "flex h-11 items-center font-medium tabular-nums",
                      loss !== null && loss > 0 && "text-red-700 dark:text-red-400",
                      loss === 0 && "text-emerald-700 dark:text-emerald-400",
                    )}
                    aria-live="polite"
                  >
                    {loss === null ? "—" : loss <= 0 ? (loss === 0 ? "None" : "—") : fmtGrams(loss)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span>
          Sent <span className="font-medium tabular-nums">{fmtGrams(totalSent)}</span> · loss{" "}
          <span className={cn("font-medium tabular-nums", totalLoss > 0 && "text-red-700 dark:text-red-400")}>
            {fmtGrams(totalLoss)}
          </span>
          {totalSent > 0 && totalLoss > 0 ? ` (${((totalLoss / totalSent) * 100).toFixed(2)}%)` : ""}
        </span>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          Review receipt
        </Button>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm receipt?</AlertDialogTitle>
            <AlertDialogDescription>
              {totalLoss > 0
                ? `${fmtGrams(totalLoss)} will be recorded as transit loss. This can't be undone.`
                : "Everything sent is received in full. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                const payload = confirming;
                if (!payload) return;
                startTransition(async () => {
                  const res = await runWarehouseAction(receiveTransferAction, payload, "Transfer received");
                  setConfirming(null);
                  if (res.ok) router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Confirm receipt"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
