"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Boxes, Pencil, Plus, Route, Trash2, Warehouse } from "lucide-react";

import { deleteExpenseAction } from "@/actions/expenses";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ExpenseForm, type AttachKind, type ExpenseFormValues, type ExpenseOptions } from "./ExpenseForm";
import { EmptyState, ResponsiveList } from "./ResponsiveList";
import { runAction } from "./run-action";
import { isoDateLabel, koboToNairaInput, money, todayLagos } from "./utils";

export type ExpenseRow = {
  id: string;
  expenseNumber: string;
  categoryId: string;
  categoryName: string;
  affectsLandedCost: boolean;
  amountKobo: number;
  expenseDate: string;
  lotId: string | null;
  tripId: string | null;
  warehouseId: string | null;
  lotNumber: string | null;
  tripNumber: string | null;
  warehouseName: string | null;
  note: string | null;
};

function AttachmentChip({ row }: { row: ExpenseRow }) {
  if (row.lotId)
    return (
      <Badge asChild variant="outline">
        <Link href={`/stock/lots/${row.lotId}`}>
          <Boxes /> {row.lotNumber ?? "Lot"}
        </Link>
      </Badge>
    );
  if (row.tripId)
    return (
      <Badge asChild variant="outline">
        <Link href={`/trips/${row.tripId}`}>
          <Route /> {row.tripNumber ?? "Trip"}
        </Link>
      </Badge>
    );
  if (row.warehouseId)
    return (
      <Badge variant="outline">
        <Warehouse /> {row.warehouseName ?? "Warehouse"}
      </Badge>
    );
  return <span className="text-xs text-muted-foreground">Overhead</span>;
}

function CategoryChip({ row }: { row: ExpenseRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant="secondary">{row.categoryName}</Badge>
      {row.affectsLandedCost ? (
        <span className="text-[11px] text-muted-foreground" title="Adds to landed cost when attached to a lot or inbound trip">
          landed
        </span>
      ) : null}
    </span>
  );
}

function toValues(r: ExpenseRow): ExpenseFormValues {
  const attach: AttachKind = r.lotId ? "lot" : r.tripId ? "trip" : r.warehouseId ? "warehouse" : "none";
  return {
    categoryId: r.categoryId,
    amountNaira: koboToNairaInput(r.amountKobo),
    expenseDate: r.expenseDate,
    attach,
    targetId: r.lotId ?? r.tripId ?? r.warehouseId ?? "",
    note: r.note ?? "",
  };
}

export function ExpensesView({
  rows,
  options,
  canWrite,
  filtered,
}: {
  rows: ExpenseRow[];
  options: ExpenseOptions;
  canWrite: boolean;
  filtered: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<ExpenseRow | "new" | null>(null);
  const [removing, setRemoving] = useState<ExpenseRow | null>(null);
  const [pending, startTransition] = useTransition();
  const noCategories = options.categories.length === 0;

  const controls = (r: ExpenseRow) =>
    canWrite ? (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon" aria-label={`Edit ${r.expenseNumber}`} onClick={() => setEditing(r)}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Delete ${r.expenseNumber}`} onClick={() => setRemoving(r)}>
          <Trash2 />
        </Button>
      </div>
    ) : null;

  const columns: ColumnDef<ExpenseRow, unknown>[] = [
    { id: "no", header: "Expense", cell: ({ row }) => <span className="font-medium">{row.original.expenseNumber}</span> },
    { id: "date", header: "Date", cell: ({ row }) => isoDateLabel(row.original.expenseDate) },
    { id: "cat", header: "Category", cell: ({ row }) => <CategoryChip row={row.original} /> },
    { id: "att", header: "Attached to", cell: ({ row }) => <AttachmentChip row={row.original} /> },
    {
      id: "note",
      header: "Note",
      cell: ({ row }) => <span className="line-clamp-1 max-w-48 text-sm text-muted-foreground">{row.original.note ?? ""}</span>,
    },
    {
      id: "amt",
      header: () => <span className="block text-right">Amount</span>,
      cell: ({ row }) => <span className="block text-right tabular-nums">{money(row.original.amountKobo)}</span>,
    },
    ...(canWrite ? [{ id: "_a", header: "", cell: ({ row }) => controls(row.original) } as ColumnDef<ExpenseRow, unknown>] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      {canWrite ? (
        <div className="flex justify-end">
          <Button className="h-11 sm:h-9" onClick={() => setEditing("new")} disabled={noCategories}>
            <Plus /> Record expense
          </Button>
        </div>
      ) : null}
      {canWrite && noCategories ? (
        <p className="text-sm text-muted-foreground">
          Add expense categories in{" "}
          <Link href="/settings/master-data?tab=expense-categories" className="underline underline-offset-4">
            master data
          </Link>{" "}
          first.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No expenses match this filter" : "No expenses yet"}
          description="Storage, fumigation, loading, bagging… attach each to a lot, a trip or a warehouse."
        />
      ) : (
        <ResponsiveList
          label="Expenses"
          data={rows}
          columns={columns}
          card={(r) => (
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{r.expenseNumber}</span>
                  <span className="tabular-nums">{money(r.amountKobo)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{isoDateLabel(r.expenseDate)}</p>
                <div className="flex flex-wrap items-center gap-1">
                  <CategoryChip row={r} />
                  <AttachmentChip row={r} />
                </div>
                {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
              </div>
              {controls(r)}
            </div>
          )}
        />
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => (o ? null : setEditing(null))}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing && editing !== "new" ? `Edit ${editing.expenseNumber}` : "Record expense"}</DialogTitle>
            <DialogDescription>
              Landed-cost categories attached to a lot or inbound trip update lot cost straight away.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <ExpenseForm
              key={editing === "new" ? "new" : editing.id}
              expenseId={editing === "new" ? undefined : editing.id}
              options={options}
              defaults={
                editing === "new"
                  ? { categoryId: "", amountNaira: "", expenseDate: todayLagos(), attach: "none", targetId: "", note: "" }
                  : toValues(editing)
              }
              onDone={() => {
                setEditing(null);
                router.refresh();
              }}
              secondary={
                <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(o) => (o ? null : setRemoving(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.expenseNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              The deletion is audited. Any landed cost it contributed is recalculated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                const r = removing;
                if (!r) return;
                startTransition(async () => {
                  const ok = await runAction(deleteExpenseAction, { id: r.id }, `${r.expenseNumber} deleted`);
                  setRemoving(null);
                  if (ok) router.refresh();
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
