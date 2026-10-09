"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Truck } from "lucide-react";
import { toast } from "sonner";

import { createDispatchAction } from "@/actions/dispatches";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { kgToGrams } from "@/lib/domain/units";
import { OutboxIndicator, QueuedBadge } from "@/offline/OutboxIndicator";
import { enqueueOp, NETWORK, tryOnline } from "@/offline/outbox";

import { sellingErrorMessage } from "./actions-client";
import { kg, kgFromGrams } from "./format";

export type ReservedAllocation = {
  id: string;
  lineLabel: string;
  lotNumber: string;
  warehouseName: string;
  kg: string;
};

const NONE = "__none__";

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.floor(Math.random() * 16) >> (Number(c) / 4))).toString(16),
      );
}

/** Pick reserved allocations + vehicle/driver → create a dispatch (waybill). */
export function DispatchForm({
  salesOrderId,
  allocations,
  vehicles,
  drivers,
}: {
  salesOrderId: string;
  allocations: ReservedAllocation[];
  vehicles: { id: string; label: string }[];
  drivers: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allocations.map((a) => a.id)));
  const [vehicleId, setVehicleId] = useState(NONE);
  const [driverId, setDriverId] = useState(NONE);
  const [clientId, setClientId] = useState(newClientId);
  const [created, setCreated] = useState<{ id: string; waybillNumber: string | null } | null>(null);
  const [queuedKg, setQueuedKg] = useState<string | null>(null);

  // Keep the selection in step with the current reserved set (after refreshes).
  const liveSelected = allocations.filter((a) => selected.has(a.id));
  const totalG = liveSelected.reduce((s, a) => s + kgToGrams(a.kg), 0);
  const allChecked = allocations.length > 0 && liveSelected.length === allocations.length;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () =>
    startTransition(async () => {
      const input = {
        clientId,
        salesOrderId,
        allocationIds: liveSelected.map((a) => a.id),
        vehicleId: vehicleId === NONE ? null : vehicleId,
        driverId: driverId === NONE ? null : driverId,
      };
      const attempt = await tryOnline(() => createDispatchAction(input));
      if (attempt === NETWORK) {
        // Offline → queue under the same client id (becomes the dispatch PK on sync).
        try {
          await enqueueOp({
            id: clientId,
            kind: "dispatch",
            payload: input,
            label: `Dispatch · ${kgFromGrams(totalG)} · ${liveSelected.length} lot${liveSelected.length === 1 ? "" : "s"}`,
          });
        } catch {
          toast.error("Could not reach the server and this browser can't queue offline. Try again.");
          return;
        }
        setQueuedKg(kgFromGrams(totalG));
        setCreated(null);
        setClientId(newClientId());
        setSelected(new Set());
        toast.info("Dispatch queued — will sync when you're back online");
        return;
      }
      const res = attempt;
      if (!res.ok) toast.error(sellingErrorMessage(res.error));
      if (res.ok) {
        setQueuedKg(null);
        setCreated({ id: res.data.id, waybillNumber: res.data.waybillNumber });
        setClientId(newClientId());
        setSelected(new Set());
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <OutboxIndicator kind="dispatch" />
      {queuedKg ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 text-sm">
          <QueuedBadge /> Dispatch of {queuedKg} saved on this phone — the waybill is issued when it syncs.
        </div>
      ) : null}
      {created ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900 sm:flex-row sm:items-center sm:justify-between dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
        >
          <p className="text-sm">
            Dispatched. Waybill <span className="font-semibold">{created.waybillNumber ?? "pending"}</span>
          </p>
          <Button asChild variant="outline" className="h-11 sm:h-8">
            <Link href={`/dispatches/${created.id}`}>Open waybill</Link>
          </Button>
        </div>
      ) : null}

      {allocations.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Nothing reserved to dispatch. Allocate stock to the lines first.
        </p>
      ) : (
        <>
          <div className="rounded-lg border">
            <label className="flex min-h-11 items-center gap-3 border-b px-3 py-2 text-sm font-medium">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(v) => setSelected(v === true ? new Set(allocations.map((a) => a.id)) : new Set())}
                aria-label="Select all reserved allocations"
              />
              Select all ({allocations.length})
            </label>
            <ul className="divide-y">
              {allocations.map((a) => (
                <li key={a.id}>
                  <label className="flex min-h-11 items-center gap-3 px-3 py-2">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={(v) => toggle(a.id, v === true)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.lotNumber}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.lineLabel} · {a.warehouseName}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums">{kg(a.kg)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="dsp-vehicle">Vehicle</FieldLabel>
              <Select value={vehicleId} onValueChange={setVehicleId}>
                <SelectTrigger id="dsp-vehicle" className="h-11 w-full">
                  <SelectValue placeholder="Select vehicle" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No vehicle</SelectItem>
                  {vehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="dsp-driver">Driver</FieldLabel>
              <Select value={driverId} onValueChange={setDriverId}>
                <SelectTrigger id="dsp-driver" className="h-11 w-full">
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No driver</SelectItem>
                  {drivers.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Button className="h-11" disabled={pending || liveSelected.length === 0} onClick={submit}>
            <Truck /> {pending ? "Dispatching…" : `Dispatch ${kgFromGrams(totalG)}`}
          </Button>
        </>
      )}
    </div>
  );
}
