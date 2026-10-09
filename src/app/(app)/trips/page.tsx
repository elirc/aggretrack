import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/logistics/ResponsiveList";
import { TripsTable, type TripRow } from "@/components/logistics/TripsTable";
import { kgLabel, money } from "@/components/logistics/utils";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { kgToGrams } from "@/lib/domain/units";
import { listTrips } from "@/lib/services/trips";
import { cn } from "@/lib/utils";

import { linkedKgByTrip, sumKg } from "./_lib/queries";

export const metadata = { title: "Trips · AggreTrack" };

const FILTERS = [
  { value: "", label: "All" },
  { value: "inbound", label: "Inbound" },
  { value: "outbound", label: "Outbound" },
] as const;

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ direction?: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "trip.read")) {
    return (
      <div>
        <PageHeader title="Trips" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to trips.</p>
      </div>
    );
  }

  const { direction: raw } = await searchParams;
  const direction = raw === "inbound" || raw === "outbound" ? raw : undefined;
  const [trips, kgMap] = await Promise.all([listTrips(db, ctx, { direction }), linkedKgByTrip(ctx)]);
  const canWrite = can(ctx.role, "trip.write") && !ctx.readOnly;

  const rows: TripRow[] = trips.map((t) => ({
    id: t.id,
    tripNumber: t.tripNumber,
    direction: t.direction,
    tripDate: t.tripDate,
    vehiclePlate: t.vehiclePlate,
    driverName: t.driverName,
    origin: t.origin,
    destination: t.destination,
    costKobo: t.costKobo,
    expensesKobo: t.expensesKobo,
    linkedCount: t.linkedCount,
    linkedKg: kgMap.get(t.id) ?? "0.000",
  }));
  const totalCost = rows.reduce((s, r) => s + r.costKobo, 0);
  const totalKg = sumKg(rows.map((r) => r.linkedKg));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Trips"
        description="Inbound collections and outbound deliveries, with cost per kg moved."
        actions={
          canWrite ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href="/trips/new">
                <Plus /> New trip
              </Link>
            </Button>
          ) : null
        }
      />

      <nav aria-label="Filter by direction" className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
        {FILTERS.map((f) => {
          const active = (direction ?? "") === f.value;
          return (
            <Link
              key={f.label}
              href={f.value ? `/trips?direction=${f.value}` : "/trips"}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-center",
                active ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title={direction ? `No ${direction} trips yet` : "No trips yet"}
          description="Record a trip to capture vehicle, driver and cost, then link the purchases or dispatches it carried."
          action={
            canWrite ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/trips/new">
                  <Plus /> Record first trip
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {rows.length} trip{rows.length === 1 ? "" : "s"} · {money(totalCost)} ·{" "}
            {kgToGrams(totalKg) > 0 ? kgLabel(totalKg) : "no linked weight"}
          </p>
          <TripsTable rows={rows} />
        </>
      )}
    </div>
  );
}
