"use client";

import { Fragment } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type AuditRow = {
  id: string;
  action: string;
  tableName: string;
  recordId: string;
  before: unknown;
  after: unknown;
  when: string;
  userName: string;
};

type DiffLine = { key: string; before: unknown; after: unknown; changed: boolean; hasBefore: boolean; hasAfter: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Key-level diff of two JSON snapshots; non-object snapshots diff as one "value" line. */
export function diffSnapshots(before: unknown, after: unknown): DiffLine[] {
  if (isPlainObject(before) || isPlainObject(after)) {
    const b = isPlainObject(before) ? before : {};
    const a = isPlainObject(after) ? after : {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    return keys.map((key) => ({
      key,
      before: b[key],
      after: a[key],
      hasBefore: key in b,
      hasAfter: key in a,
      changed: !(key in b && key in a && same(b[key], a[key])),
    }));
  }
  return [
    {
      key: "value",
      before,
      after,
      hasBefore: before !== null && before !== undefined,
      hasAfter: after !== null && after !== undefined,
      changed: !same(before, after),
    },
  ];
}

function show(v: unknown, present: boolean): string {
  if (!present) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 1) ?? "null";
}

const ACTION_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  create: "default",
  update: "secondary",
  cancel: "destructive",
  reject: "destructive",
  approve: "outline",
  post: "outline",
};

function ActionBadge({ action }: { action: string }) {
  return (
    <Badge variant={ACTION_VARIANT[action] ?? "outline"} className="capitalize">
      {action}
    </Badge>
  );
}

function DiffView({ row }: { row: AuditRow }) {
  const lines = diffSnapshots(row.before, row.after);
  const changed = lines.filter((l) => l.changed).length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Record <code className="font-mono">{row.recordId}</code> · {changed} of {lines.length} field
        {lines.length === 1 ? "" : "s"} changed
      </p>
      <div className="overflow-hidden rounded-md border text-xs">
        <div className="grid grid-cols-2 border-b bg-muted/50 font-medium">
          <div className="px-2 py-1.5">Before</div>
          <div className="border-l px-2 py-1.5">After</div>
        </div>
        {lines.map((l) => (
          <div key={l.key} className={cn("border-b last:border-b-0", l.changed ? "bg-amber-50 dark:bg-amber-950/40" : "")}>
            <div className="flex items-center gap-1 px-2 pt-1.5 font-mono text-[11px] text-muted-foreground">
              {l.changed ? (
                <span className="font-semibold text-amber-800 dark:text-amber-200" aria-label="changed">
                  ●
                </span>
              ) : null}
              <span className={l.changed ? "font-semibold text-foreground" : ""}>{l.key}</span>
            </div>
            <div className="grid grid-cols-2">
              <pre
                className={cn(
                  "px-2 pt-0.5 pb-1.5 font-mono break-all whitespace-pre-wrap",
                  l.changed && l.hasBefore ? "text-red-800 line-through decoration-red-800/40 dark:text-red-300" : "",
                )}
              >
                {show(l.before, l.hasBefore)}
              </pre>
              <pre
                className={cn(
                  "border-l px-2 pt-0.5 pb-1.5 font-mono break-all whitespace-pre-wrap",
                  l.changed && l.hasAfter ? "font-semibold text-emerald-800 dark:text-emerald-300" : "",
                )}
              >
                {show(l.after, l.hasAfter)}
              </pre>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const columns: ColumnDef<AuditRow, unknown>[] = [
  {
    id: "toggle",
    header: () => <span className="sr-only">Expand</span>,
    cell: ({ row }) => (
      <Button
        variant="ghost"
        size="icon"
        aria-expanded={row.getIsExpanded()}
        aria-label={row.getIsExpanded() ? "Hide changes" : "Show changes"}
        onClick={() => row.toggleExpanded()}
      >
        {row.getIsExpanded() ? <ChevronDown /> : <ChevronRight />}
      </Button>
    ),
  },
  { id: "when", header: "When", cell: ({ row }) => <span className="whitespace-nowrap text-sm">{row.original.when}</span> },
  { id: "who", header: "User", cell: ({ row }) => row.original.userName },
  { id: "action", header: "Action", cell: ({ row }) => <ActionBadge action={row.original.action} /> },
  { id: "table", header: "Table", cell: ({ row }) => <span className="font-mono text-xs">{row.original.tableName}</span> },
  {
    id: "record",
    header: "Record",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground" title={row.original.recordId}>
        {row.original.recordId.slice(0, 8)}…
      </span>
    ),
  },
];

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
    getRowCanExpand: () => true,
  });

  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <Table aria-label="Audit entries">
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
              <Fragment key={row.id}>
                <TableRow data-state={row.getIsExpanded() ? "selected" : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
                {row.getIsExpanded() ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={row.getVisibleCells().length} className="whitespace-normal">
                      <DiffView row={row.original} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden" aria-label="Audit entries">
        {table.getRowModel().rows.map((row) => {
          const r = row.original;
          const open = row.getIsExpanded();
          return (
            <li key={row.id}>
              <Card className="py-3">
                <CardContent className="flex flex-col gap-2 px-3">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-start justify-between gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => row.toggleExpanded()}
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <ActionBadge action={r.action} />
                        <span className="font-mono text-xs">{r.tableName}</span>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {r.when} · {r.userName}
                      </span>
                    </span>
                    {open ? <ChevronDown className="mt-1 size-4 shrink-0" /> : <ChevronRight className="mt-1 size-4 shrink-0" />}
                  </button>
                  {open ? <DiffView row={r} /> : null}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </>
  );
}
