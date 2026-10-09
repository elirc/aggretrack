"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Server-formatted report: every cell is already a display string. */
export type FormattedReport = {
  columns: { key: string; label: string; numeric: boolean }[];
  rows: Record<string, string>[];
  totals: Record<string, string> | null;
};

type Row = Record<string, string>;

/** Desktop: TanStack v8 table with a totals footer. Below md: stacked cards + totals card. */
export function ReportTable({ report }: { report: FormattedReport }) {
  const columns: ColumnDef<Row, unknown>[] = report.columns.map((c) => ({
    id: c.key,
    accessorFn: (r) => r[c.key],
    header: c.label,
    cell: (info) => info.getValue() as string,
    footer: () => report.totals?.[c.key] ?? "",
  }));
  // TanStack v8 is not React-Compiler-memoizable; the compiler skips this component by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: report.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (_r, i) => String(i),
  });
  const numeric = (id: string) => report.columns.find((c) => c.key === id)?.numeric ?? false;
  const [titleCol, ...restCols] = report.columns;

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} className={cn(numeric(h.column.id) && "text-right")}>
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
                  <TableCell
                    key={cell.id}
                    className={cn(numeric(cell.column.id) && "text-right tabular-nums whitespace-nowrap")}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          {report.totals ? (
            <TableFooter>
              {table.getFooterGroups().map((fg) => (
                <TableRow key={fg.id} className="font-semibold">
                  {fg.headers.map((h) => (
                    <TableCell
                      key={h.id}
                      className={cn(numeric(h.column.id) && "text-right tabular-nums whitespace-nowrap")}
                    >
                      {flexRender(h.column.columnDef.footer, h.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableFooter>
          ) : null}
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {report.rows.map((row, i) => (
          <li key={i}>
            <MobileCard title={titleCol ? row[titleCol.key] : ""} cols={restCols} row={row} />
          </li>
        ))}
        {report.totals ? (
          <li>
            <MobileCard
              title={titleCol ? report.totals[titleCol.key] || "Total" : "Total"}
              cols={restCols}
              row={report.totals}
              strong
            />
          </li>
        ) : null}
      </ul>
    </>
  );
}

function MobileCard({
  title,
  cols,
  row,
  strong,
}: {
  title: string;
  cols: FormattedReport["columns"];
  row: Row;
  strong?: boolean;
}) {
  return (
    <Card className={cn("py-3", strong && "border-foreground/40 bg-muted/40")}>
      <CardContent className="px-3">
        <p className={cn("mb-2 font-medium break-words", strong && "font-semibold")}>{title}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          {cols
            .filter((c) => row[c.key] !== undefined && row[c.key] !== "")
            .map((c) => (
              <div key={c.key} className="flex min-w-0 flex-col">
                <dt className="text-xs text-muted-foreground">{c.label}</dt>
                <dd className={cn("break-words", c.numeric && "tabular-nums", strong && "font-semibold")}>
                  {row[c.key]}
                </dd>
              </div>
            ))}
        </dl>
      </CardContent>
    </Card>
  );
}
