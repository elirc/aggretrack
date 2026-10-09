"use client";

import type { ReactNode } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Desktop (md+): TanStack v8 table. Below md: stacked cards (360 px friendly). */
export function ResponsiveTable<T>({
  data,
  columns,
  card,
  getRowId,
  footer,
  mobileFooter,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  card: (row: T) => ReactNode;
  getRowId: (row: T) => string;
  /** Optional <TableRow> rendered in the desktop table footer (e.g. totals). */
  footer?: ReactNode;
  /** Optional card rendered after the mobile list (e.g. totals). */
  mobileFooter?: ReactNode;
}) {
  // TanStack Table returns non-memoizable functions by design; the React Compiler lint rule flags it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), getRowId });
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
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
          {footer ? <TableFooter>{footer}</TableFooter> : null}
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
        {mobileFooter ? (
          <li>
            <Card className="py-3">
              <CardContent className="px-3">{mobileFooter}</CardContent>
            </Card>
          </li>
        ) : null}
      </ul>
    </>
  );
}
