"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import type { TripDirection } from "@/lib/validation/logistics";

import { ResponsiveList } from "./ResponsiveList";
import { DirectionBadge } from "./TripForm";
import { costPerKgKobo, isoDateLabel, kgLabel, money } from "./utils";

export type TripRow = {
  id: string;
  tripNumber: string;
  direction: TripDirection;
  tripDate: string;
  vehiclePlate: string | null;
  driverName: string | null;
  origin: string | null;
  destination: string | null;
  costKobo: number;
  expensesKobo: number;
  linkedCount: number;
  linkedKg: string;
};

function route(r: TripRow) {
  if (!r.origin && !r.destination) return "—";
  return `${r.origin ?? "?"} → ${r.destination ?? "?"}`;
}

function perKg(r: TripRow) {
  const v = costPerKgKobo(r.costKobo, r.linkedKg);
  return v === null ? "—" : `${money(v)}/kg`;
}

const columns: ColumnDef<TripRow, unknown>[] = [
  {
    id: "trip",
    header: "Trip",
    cell: ({ row }) => (
      <Link href={`/trips/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
        {row.original.tripNumber}
      </Link>
    ),
  },
  { id: "date", header: "Date", cell: ({ row }) => isoDateLabel(row.original.tripDate) },
  { id: "dir", header: "Direction", cell: ({ row }) => <DirectionBadge direction={row.original.direction} /> },
  { id: "route", header: "Route", cell: ({ row }) => <span className="text-sm">{route(row.original)}</span> },
  {
    id: "vehicle",
    header: "Vehicle / driver",
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.vehiclePlate ?? "—"}
        <span className="block text-xs text-muted-foreground">{row.original.driverName ?? ""}</span>
      </span>
    ),
  },
  {
    id: "linked",
    header: "Linked kg",
    cell: ({ row }) => (
      <span className="tabular-nums">
        {kgLabel(row.original.linkedKg)}
        <span className="block text-xs text-muted-foreground">
          {row.original.linkedCount} {row.original.direction === "inbound" ? "purchase(s)" : "dispatch(es)"}
        </span>
      </span>
    ),
  },
  {
    id: "cost",
    header: () => <span className="block text-right">Cost</span>,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums">
        {money(row.original.costKobo)}
        <span className="block text-xs text-muted-foreground">{perKg(row.original)}</span>
      </span>
    ),
  },
];

export function TripsTable({ rows }: { rows: TripRow[] }) {
  return (
    <ResponsiveList
      label="Trips"
      data={rows}
      columns={columns}
      card={(r) => (
        <Link href={`/trips/${r.id}`} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{r.tripNumber}</span>
            <DirectionBadge direction={r.direction} />
          </div>
          <p className="text-xs text-muted-foreground">
            {isoDateLabel(r.tripDate)} · {route(r)}
            {r.vehiclePlate ? ` · ${r.vehiclePlate}` : ""}
          </p>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="tabular-nums">{kgLabel(r.linkedKg)}</span>
            <span className="text-right tabular-nums">
              {money(r.costKobo)} <span className="text-xs text-muted-foreground">{perKg(r)}</span>
            </span>
          </div>
        </Link>
      )}
    />
  );
}
