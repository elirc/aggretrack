"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, CircleX, PackageCheck, Pencil } from "lucide-react";
import { toast } from "sonner";

import {
  approvePurchaseAction,
  cancelPurchaseAction,
  receivePurchaseAction,
  rejectPurchaseAction,
} from "@/actions/purchases";
import { runBuyingAction } from "@/components/buying/action-result";
import { displayKg, newUuid } from "@/components/buying/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { OutboxIndicator, QueuedBadge } from "@/offline/OutboxIndicator";
import { enqueueOp, NETWORK, tryOnline } from "@/offline/outbox";

export type WarehouseOption = { id: string; name: string; bins: Array<{ id: string; name: string }> };

const NO_BIN = "__none__";

type ReceiveDone = {
  grnNumber: string;
  totalNetKg: string;
  lots: Array<{ id: string; lotNumber: string; originalKg: string }>;
};

/**
 * Status actions for a purchase. Visibility flags are computed on the server
 * from the permission matrix; the actions re-check everything anyway.
 */
export function PurchaseActions({
  purchaseId,
  purchaseNumber,
  canApprove,
  canReceive,
  canCancel,
  canEdit,
  warehouses,
  supplierHasPhone,
}: {
  purchaseId: string;
  purchaseNumber: string | null;
  canApprove: boolean;
  canReceive: boolean;
  canCancel: boolean;
  canEdit: boolean;
  warehouses: WarehouseOption[];
  supplierHasPhone: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0].id : "");
  const [binId, setBinId] = useState("");
  const [sendSms, setSendSms] = useState(supplierHasPhone);
  const [done, setDone] = useState<ReceiveDone | null>(null);
  // Offline receipt: client id for the outbox row (server idempotency is the purchase's received state).
  const [receiptClientId] = useState(() => newUuid());
  const [queued, setQueued] = useState(false);

  const label = purchaseNumber ?? "Purchase";
  const bins = warehouses.find((w) => w.id === warehouseId)?.bins ?? [];

  if (!canApprove && !canReceive && !canCancel && !canEdit) return null;

  return (
    <>
      {canReceive ? <OutboxIndicator kind="receipt" className="mb-2" /> : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {canReceive ? (
          <Button className="col-span-2 h-12 sm:h-9" onClick={() => setReceiveOpen(true)} disabled={pending}>
            <PackageCheck /> Receive into warehouse
          </Button>
        ) : null}
        {canApprove ? (
          <>
            <Button
              className="h-12 sm:h-9"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await runBuyingAction(() => approvePurchaseAction({ id: purchaseId }), {
                    success: `${label} approved`,
                  });
                  if (res.ok) router.refresh();
                })
              }
            >
              <CircleCheck /> Approve
            </Button>
            <Button variant="outline" className="h-12 sm:h-9" disabled={pending} onClick={() => setRejectOpen(true)}>
              <CircleX /> Reject
            </Button>
          </>
        ) : null}
        {canEdit ? (
          <Button asChild variant="outline" className="h-12 sm:h-9">
            <Link href={`/purchases/${purchaseId}/edit`}>
              <Pencil /> Edit
            </Link>
          </Button>
        ) : null}
        {canCancel ? (
          <Button variant="destructive" className="h-12 sm:h-9" disabled={pending} onClick={() => setCancelOpen(true)}>
            <Ban /> Cancel purchase
          </Button>
        ) : null}
      </div>

      {/* Reject */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {label}?</DialogTitle>
            <DialogDescription>It goes back to draft so the officer can correct the price and resubmit.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="reject-reason">Reason</FieldLabel>
            <Textarea
              id="reject-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Price above today's guide for this grade"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setRejectOpen(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={pending || reason.trim() === ""}
              onClick={() =>
                startTransition(async () => {
                  const res = await runBuyingAction(() => rejectPurchaseAction({ id: purchaseId, reason }), {
                    success: `${label} sent back to draft`,
                  });
                  if (res.ok) {
                    setRejectOpen(false);
                    setReason("");
                    router.refresh();
                  }
                })
              }
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {label}?</DialogTitle>
            <DialogDescription>A cancelled purchase can&apos;t be received or paid. This is recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="cancel-reason">Reason (optional)</FieldLabel>
            <Textarea id="cancel-reason" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setCancelOpen(false)}>
              Keep purchase
            </Button>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await runBuyingAction(
                    () => cancelPurchaseAction({ id: purchaseId, reason: cancelReason }),
                    { success: `${label} cancelled` },
                  );
                  if (res.ok) {
                    setCancelOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              Cancel purchase
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receive */}
      <Dialog
        open={receiveOpen}
        onOpenChange={(o) => {
          setReceiveOpen(o);
          if (!o && done) {
            setDone(null);
            router.refresh();
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          {queued ? (
            <>
              <DialogHeader>
                <DialogTitle>Receipt queued · {label}</DialogTitle>
                <DialogDescription>
                  Saved on this phone. Stock is added and the GRN issued when it syncs.
                </DialogDescription>
              </DialogHeader>
              <QueuedBadge />
              <DialogFooter>
                <Button className="h-11 sm:h-9" onClick={() => setReceiveOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : done ? (
            <>
              <DialogHeader>
                <DialogTitle>Received · {done.grnNumber}</DialogTitle>
                <DialogDescription>
                  {displayKg(done.totalNetKg)} into stock. The goods received note PDF is being generated.
                </DialogDescription>
              </DialogHeader>
              <ul className="flex flex-col gap-1 text-sm">
                {done.lots.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <Link href={`/stock/lots/${l.id}`} className="font-medium underline-offset-4 hover:underline">
                      {l.lotNumber}
                    </Link>
                    <span className="tabular-nums text-muted-foreground">{displayKg(l.originalKg)}</span>
                  </li>
                ))}
              </ul>
              <DialogFooter>
                <Button
                  className="h-11 sm:h-9"
                  onClick={() => {
                    setReceiveOpen(false);
                    setDone(null);
                    router.refresh();
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Receive {label}</DialogTitle>
                <DialogDescription>Creates one lot per line, adds the stock and issues a GRN.</DialogDescription>
              </DialogHeader>
              {warehouses.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active warehouse is available to you.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  <Field>
                    <FieldLabel htmlFor="rcv-wh">Warehouse</FieldLabel>
                    <Select
                      value={warehouseId}
                      onValueChange={(v) => {
                        setWarehouseId(v);
                        setBinId("");
                      }}
                    >
                      <SelectTrigger id="rcv-wh" className="h-12 w-full">
                        <SelectValue placeholder="Pick warehouse" />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id} className="min-h-10">
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {bins.length > 0 ? (
                    <Field>
                      <FieldLabel htmlFor="rcv-bin">Bin</FieldLabel>
                      <Select value={binId || NO_BIN} onValueChange={(v) => setBinId(v === NO_BIN ? "" : v)}>
                        <SelectTrigger id="rcv-bin" className="h-12 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_BIN} className="min-h-10">
                            No specific bin
                          </SelectItem>
                          {bins.map((b) => (
                            <SelectItem key={b.id} value={b.id} className="min-h-10">
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {supplierHasPhone ? (
                    <Field orientation="horizontal">
                      <Switch id="rcv-sms" checked={sendSms} onCheckedChange={setSendSms} />
                      <div className="flex flex-col">
                        <FieldLabel htmlFor="rcv-sms">SMS receipt to supplier</FieldLabel>
                        <FieldDescription>Quantity, amount and GRN number.</FieldDescription>
                      </div>
                    </Field>
                  ) : null}
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" className="h-11 sm:h-9" onClick={() => setReceiveOpen(false)}>
                  Not now
                </Button>
                <Button
                  className="h-11 sm:h-9"
                  disabled={pending || !warehouseId}
                  onClick={() =>
                    startTransition(async () => {
                      const input = {
                        purchaseId,
                        warehouseId,
                        binId: binId || null,
                        sendSms: supplierHasPhone && sendSms,
                      };
                      const attempt = await tryOnline(() => receivePurchaseAction(input));
                      if (attempt === NETWORK) {
                        try {
                          await enqueueOp({
                            id: receiptClientId,
                            kind: "receipt",
                            payload: input,
                            label: `Receipt · ${label} · ${warehouses.find((w) => w.id === warehouseId)?.name ?? "warehouse"}`,
                          });
                        } catch {
                          toast.error("Could not reach the server and this browser can't queue offline. Try again.");
                          return;
                        }
                        setQueued(true);
                        toast.info("Receipt queued — will sync when you're back online");
                        return;
                      }
                      const res = await runBuyingAction(async () => attempt, {
                        success: (d) => `Received · ${d.grnNumber}`,
                      });
                      if (res.ok) {
                        setDone({ grnNumber: res.data.grnNumber, totalNetKg: res.data.totalNetKg, lots: res.data.lots });
                      }
                    })
                  }
                >
                  {pending ? "Receiving…" : "Receive"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
