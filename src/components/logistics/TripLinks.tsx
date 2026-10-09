"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2, Search, Unlink } from "lucide-react";
import { toast } from "sonner";

import {
  linkTripDispatchesAction,
  linkTripPurchasesAction,
  unlinkTripDispatchAction,
  unlinkTripPurchaseAction,
} from "@/actions/trips";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TripDirection } from "@/lib/validation/logistics";

import { runAction } from "./run-action";
import { kgLabel } from "./utils";

export type LinkRow = {
  id: string;
  primary: string;
  secondary: string;
  kg: string;
  href?: string;
};

export function TripLinks({
  tripId,
  direction,
  linked,
  candidates,
  canWrite,
}: {
  tripId: string;
  direction: TripDirection;
  linked: LinkRow[];
  candidates: LinkRow[];
  canWrite: boolean;
}) {
  const noun = direction === "inbound" ? "purchase" : "dispatch";
  const plural = direction === "inbound" ? "purchases" : "dispatches";
  const [open, setOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<LinkRow | null>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const unlink = (row: LinkRow) =>
    startTransition(async () => {
      const ok =
        direction === "inbound"
          ? await runAction(unlinkTripPurchaseAction, { tripId, purchaseId: row.id }, "Purchase unlinked")
          : await runAction(unlinkTripDispatchAction, { tripId, dispatchId: row.id }, "Dispatch unlinked");
      setUnlinking(null);
      if (ok) router.refresh();
    });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="trip-links-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="trip-links-h" className="text-base font-semibold capitalize">
          Linked {plural}
        </h2>
        {canWrite ? (
          <Button className="h-11 sm:h-9" variant="outline" onClick={() => setOpen(true)}>
            <Link2 /> Link {plural}
          </Button>
        ) : null}
      </div>

      {linked.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No {plural} linked yet.
          {direction === "inbound" ? " Link the purchases this trip collected to share its cost into landed cost." : ""}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {linked.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                {row.href ? (
                  <Link href={row.href} className="font-medium underline-offset-4 hover:underline">
                    {row.primary}
                  </Link>
                ) : (
                  <span className="font-medium">{row.primary}</span>
                )}
                <p className="truncate text-xs text-muted-foreground">{row.secondary}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-sm tabular-nums">{kgLabel(row.kg)}</span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Unlink ${row.primary}`}
                    disabled={pending}
                    onClick={() => setUnlinking(row)}
                  >
                    <Unlink />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <LinkDialog
          tripId={tripId}
          direction={direction}
          candidates={candidates}
          noun={noun}
          plural={plural}
          onClose={() => setOpen(false)}
        />
      ) : null}

      <AlertDialog open={unlinking !== null} onOpenChange={(o) => (o ? null : setUnlinking(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {unlinking?.primary}?</AlertDialogTitle>
            <AlertDialogDescription>
              {direction === "inbound"
                ? "Its lots stop sharing this trip's cost; landed cost is recalculated."
                : "The dispatch stays as it is; only the trip link is removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (unlinking) unlink(unlinking);
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function LinkDialog({
  tripId,
  direction,
  candidates,
  noun,
  plural,
  onClose,
}: {
  tripId: string;
  direction: TripDirection;
  candidates: LinkRow[];
  noun: string;
  plural: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => `${c.primary} ${c.secondary}`.toLowerCase().includes(q));
  }, [candidates, query]);

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () =>
    startTransition(async () => {
      const ids = [...picked];
      const res =
        direction === "inbound"
          ? await runAction(linkTripPurchasesAction, { tripId, purchaseIds: ids })
          : await runAction(linkTripDispatchesAction, { tripId, dispatchIds: ids });
      if (res) {
        toast.success(`${res.linked} ${res.linked === 1 ? noun : plural} linked`);
        onClose();
        router.refresh();
      }
    });

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize">Link {plural}</DialogTitle>
          <DialogDescription>
            {direction === "inbound"
              ? "Pick the purchases this trip collected. Cancelled purchases are not listed."
              : "Pick the dispatches this trip delivered."}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={direction === "inbound" ? "Search number or supplier" : "Search waybill, order or customer"}
            className="h-11 pl-9"
            aria-label={`Search ${plural}`}
            autoFocus
          />
        </div>
        <ScrollArea className="h-[45dvh] rounded-md border">
          {shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {candidates.length === 0 ? `No ${plural} available to link.` : "Nothing matches that search."}
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((c) => {
                const id = `pick-${c.id}`;
                return (
                  <li key={c.id}>
                    <label htmlFor={id} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2">
                      <Checkbox id={id} checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{c.primary}</span>
                        <span className="block truncate text-xs text-muted-foreground">{c.secondary}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums">{kgLabel(c.kg)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" className="h-11 sm:h-9" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button className="h-11 sm:h-9" onClick={submit} disabled={pending || picked.size === 0}>
            {pending ? "Linking…" : picked.size === 0 ? `Link ${plural}` : `Link ${picked.size} ${picked.size === 1 ? noun : plural}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
