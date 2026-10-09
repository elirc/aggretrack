"use client";

import type { ReactNode } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type BuyingColumn<T> = ColumnDef<T, unknown> & { meta?: { className?: string; headerClassName?: string } };

/** Desktop (md+): TanStack v8 table. Below md: stacked cards. */
export function ResponsiveTable<T>({
  data,
  columns,
  card,
  getRowId,
  footer,
  mobileFooter,
}: {
  data: T[];
  columns: BuyingColumn<T>[];
  card: (row: T) => ReactNode;
  getRowId: (row: T) => string;
  /** Optional totals row (desktop) — one cell per visible column, in order. */
  footer?: ReactNode[];
  mobileFooter?: ReactNode;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), getRowId });
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as { className?: string; headerClassName?: string } | undefined;
                  return (
                    <TableHead key={h.id} className={cn(meta?.className, meta?.headerClassName)}>
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as { className?: string } | undefined;
                  return (
                    <TableCell key={cell.id} className={meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
          {footer ? (
            <TableFooter>
              <TableRow>
                {footer.map((f, i) => {
                  const meta = columns[i]?.meta;
                  return (
                    <TableCell key={i} className={cn("font-semibold", meta?.className)}>
                      {f}
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {data.map((row) => (
          <li key={getRowId(row)}>
            <Card className="py-3">
              <CardContent className="px-3">{card(row)}</CardContent>
            </Card>
          </li>
        ))}
        {mobileFooter ? <li>{mobileFooter}</li> : null}
      </ul>
    </>
  );
}
