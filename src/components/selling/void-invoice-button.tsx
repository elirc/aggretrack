"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";

import { voidInvoiceAction } from "@/actions/invoices";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { callAction } from "./actions-client";

export function VoidInvoiceButton({ invoiceId, invoiceNumber }: { invoiceId: string; invoiceNumber: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" className="h-11 sm:h-9" disabled={pending}>
          <Ban /> Void
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void {invoiceNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            The invoice stops counting towards what the customer owes. The number stays used. Invoices with payments
            allocated can&apos;t be voided.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11 sm:h-8">Keep invoice</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="h-11 sm:h-8"
            onClick={() =>
              startTransition(async () => {
                const res = await callAction(voidInvoiceAction, { id: invoiceId }, "Invoice voided");
                if (res.ok) router.refresh();
              })
            }
          >
            Void invoice
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
