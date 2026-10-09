"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { approveAdjustmentAction, rejectAdjustmentAction } from "@/actions/adjustments";
import { rejectAdjustmentInput } from "@/lib/validation/warehouse";

import { runWarehouseAction } from "./run-action";

type RejectIn = z.input<typeof rejectAdjustmentInput>;
type RejectOut = z.output<typeof rejectAdjustmentInput>;

/** Approve (confirm) / reject (reason dialog) for one pending adjustment. */
export function AdjustmentDecision({ adjustmentId, label }: { adjustmentId: string; label: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<RejectIn, unknown, RejectOut>({
    resolver: zodResolver(rejectAdjustmentInput),
    defaultValues: { adjustmentId, reason: "" },
  });

  const close = () => {
    setMode(null);
    form.reset({ adjustmentId, reason: "" });
  };

  const onReject = form.handleSubmit((values) => {
    startTransition(async () => {
      const res = await runWarehouseAction(rejectAdjustmentAction, values, `${label} rejected`);
      if (res.ok) {
        close();
        router.refresh();
      } else if (res.fieldErrors?.reason?.[0]) {
        form.setError("reason", { message: res.fieldErrors.reason[0] });
      }
    });
  });

  return (
    <div className="flex gap-2">
      <Button variant="outline" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setMode("reject")}>
        Reject
      </Button>
      <Button className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setMode("approve")}>
        Approve
      </Button>

      <AlertDialog open={mode === "approve"} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {label}?</AlertDialogTitle>
            <AlertDialogDescription>The stock movement is posted now and can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const res = await runWarehouseAction(approveAdjustmentAction, { adjustmentId }, `${label} approved`);
                  close();
                  if (res.ok) router.refresh();
                });
              }}
            >
              {pending ? "Posting…" : "Approve"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={mode === "reject"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {label}</DialogTitle>
            <DialogDescription>Stock is not changed. The reason is kept on the record.</DialogDescription>
          </DialogHeader>
          <form onSubmit={onReject} noValidate className="flex flex-col gap-4">
            <Controller
              name="reason"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor={`rej-${adjustmentId}`}>Reason</FieldLabel>
                  <Textarea
                    id={`rej-${adjustmentId}`}
                    {...field}
                    rows={3}
                    placeholder="e.g. Recount shows the bags are in bin B2"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={close} disabled={pending}>
                Back
              </Button>
              <Button type="submit" variant="destructive" className="h-11 sm:h-9" disabled={pending}>
                {pending ? "Saving…" : "Reject adjustment"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
