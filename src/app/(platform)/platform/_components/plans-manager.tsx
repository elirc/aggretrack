"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { z } from "zod";

import { createPlanAction, setPlanActiveAction, updatePlanAction } from "@/actions/platform";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { zUuid } from "@/lib/validation/common";
import { planInput } from "@/lib/validation/masterData";
import { ActiveToggle, EmptyState } from "@/app/(app)/settings/master-data/_components/entity-section";
import { EntityForm, type FieldSpec, type FormValues } from "@/app/(app)/settings/master-data/_components/form-kit";

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  monthlyPriceKobo: number;
  userLimit: number;
  paystackPlanCode: string | null;
  active: boolean;
  subscriptionCount: number;
};

/** "15000.50" naira → 1500050 kobo, without float math. */
function nairaToKobo(s: string): number {
  const [int, frac = ""] = s.trim().split(".");
  return Number.parseInt(int || "0", 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
}
function koboToNaira(k: number): string {
  const rem = k % 100;
  return rem ? `${Math.trunc(k / 100)}.${String(rem).padStart(2, "0")}` : String(Math.trunc(k / 100));
}
function fmtNaira(kobo: number): string {
  return `₦${Math.trunc(kobo / 100).toLocaleString("en-NG")}${kobo % 100 ? `.${String(kobo % 100).padStart(2, "0")}` : ""}`;
}

const zNaira = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount in naira, e.g. 15000");

const planForm = planInput
  .omit({ monthlyPriceKobo: true, userLimit: true })
  .extend({
    monthlyPriceNaira: zNaira,
    userLimit: z.coerce.number().int("Whole number").min(1, "At least 1"),
  });
const planUpdateForm = planForm.extend({ id: zUuid });

const fields: FieldSpec[] = [
  { name: "code", label: "Code", kind: "text", placeholder: "e.g. growth", description: "Lower-case identifier." },
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. Growth" },
  { name: "monthlyPriceNaira", label: "Monthly price (₦)", kind: "text", inputMode: "decimal", placeholder: "15000" },
  { name: "userLimit", label: "User limit", kind: "text", inputMode: "numeric", placeholder: "10" },
  { name: "paystackPlanCode", label: "Paystack plan code", kind: "text", placeholder: "PLN_…" },
  { name: "active", label: "Active (offered to organisations)", kind: "switch" },
];

const blank: FormValues = {
  code: "",
  name: "",
  monthlyPriceNaira: "",
  userLimit: "",
  paystackPlanCode: "",
  active: true,
};

function toPayload(v: FormValues): unknown {
  const { monthlyPriceNaira, ...rest } = v;
  return { ...rest, monthlyPriceKobo: nairaToKobo(String(monthlyPriceNaira ?? "0")) };
}

export function PlansManager({ plans }: { plans: PlanRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (p: PlanRow) => {
    setEditing(p);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-3">
      {plans.length > 0 ? (
        <div className="flex justify-end">
          <Button className="h-11 sm:h-9" onClick={openCreate}>
            <Plus /> Add plan
          </Button>
        </div>
      ) : null}

      {plans.length === 0 ? (
        <EmptyState title="No plans yet" actionLabel="Add first plan" onAction={openCreate} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>User limit</TableHead>
                  <TableHead>Subscriptions</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="tabular-nums">{fmtNaira(p.monthlyPriceKobo)}</TableCell>
                    <TableCell className="tabular-nums">{p.userLimit}</TableCell>
                    <TableCell className="tabular-nums">{p.subscriptionCount}</TableCell>
                    <TableCell>
                      <ActiveToggle id={p.id} checked={p.active} action={setPlanActiveAction} label={p.name} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p)}>
                        <Pencil />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {plans.map((p) => (
              <li key={p.id}>
                <Card className="py-3">
                  <CardContent className="flex items-start justify-between gap-2 px-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-medium">
                        {p.name} <Badge variant="outline">{p.code}</Badge>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {fmtNaira(p.monthlyPriceKobo)}/mo · {p.userLimit} users · {p.subscriptionCount} subs
                      </span>
                      <ActiveToggle id={p.id} checked={p.active} action={setPlanActiveAction} label={p.name} />
                    </div>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p)}>
                      <Pencil />
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "Add plan"}</DialogTitle>
            <DialogDescription>Prices are monthly, in naira.</DialogDescription>
          </DialogHeader>
          {open ? (
            <EntityForm
              key={editing?.id ?? "new"}
              fields={fields}
              schema={editing ? planUpdateForm : planForm}
              defaultValues={
                editing
                  ? {
                      id: editing.id,
                      code: editing.code,
                      name: editing.name,
                      monthlyPriceNaira: koboToNaira(editing.monthlyPriceKobo),
                      userLimit: String(editing.userLimit),
                      paystackPlanCode: editing.paystackPlanCode ?? "",
                      active: editing.active,
                    }
                  : blank
              }
              transform={toPayload}
              action={editing ? updatePlanAction : createPlanAction}
              successMessage={editing ? "Plan saved" : "Plan added"}
              submitLabel={editing ? "Save changes" : "Add plan"}
              onSuccess={() => {
                setOpen(false);
                router.refresh();
              }}
              secondary={
                <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
