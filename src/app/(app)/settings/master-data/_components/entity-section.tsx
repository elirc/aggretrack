"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { EntityForm, runAction, type AnyAction, type FieldSpec, type FormValues } from "./form-kit";

/** Desktop: TanStack table. Small screens: stacked cards. */
export function ResponsiveList<T extends { id: string }>({
  data,
  columns,
  card,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  card: (row: T) => ReactNode;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.id });
  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {data.map((row) => (
          <li key={row.id}>
            <Card className="py-3">
              <CardContent className="px-3">{card(row)}</CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {actionLabel && onAction ? (
        <Button className="h-11 sm:h-9" onClick={onAction}>
          <Plus /> {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function ActiveToggle({
  checked,
  disabled,
  action,
  id,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  action: AnyAction;
  id: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Switch
        checked={checked}
        disabled={disabled || pending}
        aria-label={`${label} active`}
        onCheckedChange={(v) =>
          startTransition(async () => {
            const ok = await runAction(action, { id, active: v }, v ? `${label} activated` : `${label} deactivated`);
            if (ok) router.refresh();
          })
        }
      />
      {checked ? "Active" : "Inactive"}
    </label>
  );
}

export function RemoveButton({
  action,
  id,
  label,
  disabled,
}: {
  action: AnyAction;
  id: string;
  label: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${label}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2 />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Records already using it are protected — removal is refused if it is in use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const ok = await runAction(action, { id }, `${label} removed`);
                  setOpen(false);
                  if (ok) router.refresh();
                });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export type EntitySectionProps<T extends { id: string }> = {
  /** Singular, lower case: "commodity". */
  noun: string;
  description?: string;
  rows: T[];
  columns: ColumnDef<T, unknown>[];
  card: (row: T) => ReactNode;
  /** Short display label of a row for dialogs/toasts. */
  rowLabel: (row: T) => string;
  fields: FieldSpec[];
  createSchema: z.ZodType;
  updateSchema: z.ZodType;
  createAction: AnyAction;
  updateAction: AnyAction;
  emptyDefaults: FormValues;
  toValues: (row: T) => FormValues;
  /** Extra per-row controls (active toggle, remove, bins…). */
  rowActions?: (row: T) => ReactNode;
  canWrite: boolean;
  /** Shown instead of the add button when creation is impossible (e.g. grades without commodities). */
  blockedReason?: string;
};

export function EntitySection<T extends { id: string }>(props: EntitySectionProps<T>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const { noun, canWrite } = props;

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (row: T) => {
    setEditing(row);
    setOpen(true);
  };

  const controls = (row: T) =>
    canWrite ? (
      <div className="flex items-center justify-end gap-1">
        {props.rowActions?.(row)}
        <Button variant="ghost" size="icon" aria-label={`Edit ${props.rowLabel(row)}`} onClick={() => openEdit(row)}>
          <Pencil />
        </Button>
      </div>
    ) : null;

  const columns: ColumnDef<T, unknown>[] = canWrite
    ? [...props.columns, { id: "_actions", header: "", cell: ({ row }) => controls(row.original) }]
    : props.columns;

  const card = (row: T) => (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">{props.card(row)}</div>
      {controls(row)}
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {props.description ? <p className="text-sm text-muted-foreground">{props.description}</p> : <span />}
        {canWrite && props.rows.length > 0 && !props.blockedReason ? (
          <Button className="h-11 sm:h-9" onClick={openCreate}>
            <Plus /> Add {noun}
          </Button>
        ) : null}
      </div>

      {props.rows.length === 0 ? (
        <EmptyState
          title={`No ${noun} records yet`}
          description={props.blockedReason}
          actionLabel={canWrite && !props.blockedReason ? `Add first ${noun}` : undefined}
          onAction={openCreate}
        />
      ) : (
        <ResponsiveList data={props.rows} columns={columns} card={card} />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${props.rowLabel(editing)}` : `Add ${noun}`}</DialogTitle>
            <DialogDescription>{editing ? "Update the details and save." : `Create a new ${noun}.`}</DialogDescription>
          </DialogHeader>
          {open ? (
            <EntityForm
              key={editing?.id ?? "new"}
              fields={props.fields}
              schema={editing ? props.updateSchema : props.createSchema}
              defaultValues={editing ? { ...props.toValues(editing), id: editing.id } : props.emptyDefaults}
              action={editing ? props.updateAction : props.createAction}
              successMessage={editing ? "Saved" : `${capitalise(noun)} added`}
              submitLabel={editing ? "Save changes" : `Add ${noun}`}
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
    </section>
  );
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
