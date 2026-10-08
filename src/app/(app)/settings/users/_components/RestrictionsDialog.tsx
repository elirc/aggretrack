"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, MapPin } from "lucide-react";
import { setMemberRestrictionsAction } from "@/actions/users";
import type { AccessOptions } from "@/lib/services/users";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { actionErrorMessage } from "@/components/auth/messages";

interface RestrictionsDialogProps {
  memberId: string;
  memberName: string;
  warehouseIds: string[] | null;
  buyingPointIds: string[] | null;
  options: AccessOptions;
  disabled?: boolean;
}

function summary(ids: string[] | null, total: number, noun: string): string {
  if (!ids || ids.length === 0) return `All ${noun}`;
  return `${ids.length} of ${total} ${noun}`;
}

export function RestrictionsSummary({
  warehouseIds,
  buyingPointIds,
  options,
}: Pick<RestrictionsDialogProps, "warehouseIds" | "buyingPointIds" | "options">) {
  return (
    <span className="text-xs text-muted-foreground">
      {summary(warehouseIds, options.warehouses.length, "warehouses")} ·{" "}
      {summary(buyingPointIds, options.buyingPoints.length, "buying points")}
    </span>
  );
}

function CheckList({
  legend,
  hint,
  items,
  selected,
  onToggle,
  prefix,
}: {
  legend: string;
  hint: string;
  items: { id: string; name: string }[];
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  prefix: string;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <p className="-mt-2 text-xs text-muted-foreground">{hint}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None set up yet.</p>
      ) : (
        <div className="grid gap-1">
          {items.map((it) => {
            const id = `${prefix}-${it.id}`;
            return (
              <Field key={it.id} orientation="horizontal" className="min-h-10">
                <Checkbox
                  id={id}
                  checked={selected.has(it.id)}
                  onCheckedChange={(v) => onToggle(it.id, v === true)}
                />
                <FieldLabel htmlFor={id} className="font-normal">
                  {it.name}
                </FieldLabel>
              </Field>
            );
          })}
        </div>
      )}
    </FieldSet>
  );
}

export function RestrictionsDialog({
  memberId,
  memberName,
  warehouseIds,
  buyingPointIds,
  options,
  disabled,
}: RestrictionsDialogProps) {
  const [open, setOpen] = useState(false);
  const [wh, setWh] = useState(() => new Set(warehouseIds ?? []));
  const [bp, setBp] = useState(() => new Set(buyingPointIds ?? []));
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      setWh(new Set(warehouseIds ?? []));
      setBp(new Set(buyingPointIds ?? []));
    }
    setOpen(next);
  }

  const toggle =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string, on: boolean) =>
      setter((prev) => {
        const n = new Set(prev);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });

  function save() {
    startTransition(async () => {
      const res = await setMemberRestrictionsAction({
        memberId,
        warehouseIds: [...wh],
        buyingPointIds: [...bp],
      });
      if (!res.ok) {
        toast.error(actionErrorMessage(res.error));
        return;
      }
      toast.success(`Access updated for ${memberName}`);
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <MapPin className="size-4" />
          Access
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Access for {memberName}</DialogTitle>
          <DialogDescription>
            Leave everything unticked to allow all warehouses / buying points.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <CheckList
            legend="Warehouses"
            hint={wh.size === 0 ? "Unrestricted — all warehouses" : `${wh.size} selected`}
            items={options.warehouses}
            selected={wh}
            onToggle={toggle(setWh)}
            prefix={`wh-${memberId}`}
          />
          <CheckList
            legend="Buying points"
            hint={bp.size === 0 ? "Unrestricted — all buying points" : `${bp.size} selected`}
            items={options.buyingPoints}
            selected={bp}
            onToggle={toggle(setBp)}
            prefix={`bp-${memberId}`}
          />
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={pending} className="h-11 w-full sm:w-auto">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
