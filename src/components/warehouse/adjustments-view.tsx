"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { kgToGrams } from "@/lib/domain/units";

import { AdjustmentDecision } from "./adjustment-decision";
import { ADJUSTMENT_REASON_LABEL, formatLagosDateTime } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { SignedKg, StatusBadge } from "./status";

export type AdjustmentRow = {
  id: string;
  adjustmentNumber: string;
  lotId: string;
  lotLabel: string;
  warehouseName: string;
  reason: string;
  kg: string;
  bags: number;
  status: string;
  note: string | null;
  rejectedReason: string | null;
  sourceCountId: string | null;
  createdAt: Date;
};

const columns: ColumnDef<AdjustmentRow, unknown>[] = [
  {
    id: "number",
    header: "Adjustment",
    cell: ({ row }) => (
      <Link href={`/adjustments/${row.original.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
        {row.original.adjustmentNumber}
      </Link>
    ),
  },
  {
    id: "lot",
    header: "Lot",
    cell: ({ row }) => (
      <Link href={`/stock/lots/${row.original.lotId}`} className="underline-offset-4 hover:underline">
        {row.original.lotLabel}
      </Link>
    ),
  },
  { id: "warehouse", header: "Warehouse", cell: ({ row }) => row.original.warehouseName },
  {
    id: "reason",
    header: "Reason",
    cell: ({ row }) => ADJUSTMENT_REASON_LABEL[row.original.reason] ?? row.original.reason,
  },
  {
    id: "kg",
    header: () => <span className="block text-right">Kg</span>,
    cell: ({ row }) => (
      <span className="block text-right">
        <SignedKg grams={kgToGrams(row.original.kg)} />
      </span>
    ),
  },
  { id: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
  { id: "when", header: "Created", cell: ({ row }) => formatLagosDateTime(row.original.createdAt) },
];

function AdjustmentCard({ a }: { a: AdjustmentRow }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/adjustments/${a.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
          {a.adjustmentNumber}
        </Link>
        <StatusBadge status={a.status} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/stock/lots/${a.lotId}`} className="underline-offset-4 hover:underline">
          {a.lotLabel}
        </Link>
        <SignedKg grams={kgToGrams(a.kg)} />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason} · {a.warehouseName}
        </span>
        <span>{formatLagosDateTime(a.createdAt)}</span>
      </div>
      {a.note ? <p className="text-xs text-muted-foreground">“{a.note}”</p> : null}
    </div>
  );
}

export function AdjustmentsView({
  rows,
  queue,
  canApprove,
  initialTab,
  listFooter,
}: {
  rows: AdjustmentRow[];
  queue: AdjustmentRow[];
  canApprove: boolean;
  initialTab: "all" | "queue";
  listFooter?: React.ReactNode;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <TabsList className="w-full sm:w-auto">
        <TabsTrigger value="all" className="flex-1 sm:flex-none">
          All
        </TabsTrigger>
        <TabsTrigger value="queue" className="flex-1 sm:flex-none">
          Approval queue
          {queue.length > 0 ? (
            <Badge variant="secondary" className="ml-1 bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              {queue.length}
            </Badge>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="all">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No adjustments match these filters.
          </p>
        ) : (
          <>
            <ResponsiveTable data={rows} columns={columns} getRowId={(r) => r.id} card={(a) => <AdjustmentCard a={a} />} />
            {listFooter}
          </>
        )}
      </TabsContent>

      <TabsContent value="queue">
        {queue.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing waiting for approval.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 rounded-lg border bg-card p-3">
                <AdjustmentCard a={a} />
                {a.sourceCountId ? (
                  <Link href={`/counts/${a.sourceCountId}`} className="text-xs underline-offset-4 hover:underline">
                    From stock count
                  </Link>
                ) : null}
                {canApprove ? (
                  <AdjustmentDecision adjustmentId={a.id} label={a.adjustmentNumber} />
                ) : (
                  <p className="text-xs text-muted-foreground">A manager or owner approves this.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  );
}
