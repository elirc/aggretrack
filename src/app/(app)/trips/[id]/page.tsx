import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { DeleteTripButton } from "@/components/logistics/DeleteTripButton";
import { DirectionBadge, TripForm } from "@/components/logistics/TripForm";
import { TripLinks, type LinkRow } from "@/components/logistics/TripLinks";
import { costPerKgKobo, isoDateLabel, kgLabel, koboToNairaInput, money } from "@/components/logistics/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { DomainError } from "@/lib/domain/errors";
import { formatLagosDate } from "@/lib/domain/format";
import { listDispatches } from "@/lib/services/dispatches";
import { listDrivers, listExpenseCategories, listVehicles } from "@/lib/services/masterData";
import { listPurchases } from "@/lib/services/purchases";
import { getTrip, type TripDetail } from "@/lib/services/trips";

import { purchaseNetKg, sumKg } from "../_lib/queries";

export const metadata = { title: "Trip · AggreTrack" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "trip.read")) {
    return (
      <div>
        <PageHeader title="Trip" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to trips.</p>
      </div>
    );
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  let trip: TripDetail;
  try {
    trip = await getTrip(db, ctx, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const canWrite = can(ctx.role, "trip.write") && !ctx.readOnly;
  const inbound = trip.direction === "inbound";

  const [vehicles, drivers, categories, candidatesRaw, linkedKgMap] = await Promise.all([
    listVehicles(db, ctx),
    listDrivers(db, ctx),
    listExpenseCategories(db, ctx),
    canWrite
      ? inbound
        ? listPurchases(db, ctx, { pageSize: 200 }).then((r) =>
            r.rows
              .filter((p) => p.status !== "cancelled")
              .map<LinkRow>((p) => ({
                id: p.id,
                primary: p.purchaseNumber ?? "Draft purchase",
                secondary: `${p.supplierName} · ${isoDateLabel(p.purchaseDate)}${p.buyingPointName ? ` · ${p.buyingPointName}` : ""}`,
                kg: p.netKg,
              })),
          )
        : listDispatches(db, ctx, { pageSize: 200 }).then((r) =>
            r.rows.map<LinkRow>((d) => ({
              id: d.id,
              primary: d.waybillNumber ?? "Dispatch",
              secondary: `${d.orderNumber} · ${d.customerName} · ${formatLagosDate(d.dispatchedAt)}`,
              kg: d.dispatchedKg,
            })),
          )
      : Promise.resolve([] as LinkRow[]),
    purchaseNetKg(
      ctx,
      trip.purchases.map((p) => p.purchaseId),
    ),
  ]);

  const linked: LinkRow[] = inbound
    ? trip.purchases.map((p) => ({
        id: p.purchaseId,
        primary: p.purchaseNumber ?? "Draft purchase",
        secondary: `${p.supplierName} · ${isoDateLabel(p.purchaseDate)} · ${p.status.replace(/_/g, " ")}`,
        kg: linkedKgMap.get(p.purchaseId) ?? "0.000",
        href: `/purchases/${p.purchaseId}`,
      }))
    : trip.dispatches.map((d) => ({
        id: d.dispatchId,
        primary: d.waybillNumber ?? "Dispatch",
        secondary: `${d.orderNumber} · ${formatLagosDate(d.dispatchedAt)}`,
        kg: d.dispatchedKg,
        href: `/dispatches/${d.dispatchId}`,
      }));
  const linkedIds = new Set(linked.map((l) => l.id));
  const candidates = candidatesRaw.filter((c) => !linkedIds.has(c.id));

  const linkedKg = sumKg(linked.map((l) => l.kg));
  const expensesKobo = trip.expenses.reduce((s, e) => s + e.amountKobo, 0);
  const tripPerKg = costPerKgKobo(trip.costKobo, linkedKg);
  const allInPerKg = costPerKgKobo(trip.costKobo + expensesKobo, linkedKg);
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col gap-4">
      <Link href="/trips" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> Trips
      </Link>
      <PageHeader
        title={`Trip ${trip.tripNumber}`}
        description={`${isoDateLabel(trip.tripDate)}${trip.vehiclePlate ? ` · ${trip.vehiclePlate}` : ""}${trip.driverName ? ` · ${trip.driverName}` : ""}`}
        actions={canWrite ? <DeleteTripButton tripId={trip.id} tripNumber={trip.tripNumber} /> : null}
      />

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Direction" value={<DirectionBadge direction={trip.direction} />} />
        <Stat label="Linked weight" value={kgLabel(linkedKg)} />
        <Stat label="Trip cost / kg" value={tripPerKg === null ? "—" : `${money(tripPerKg)}`} hint={money(trip.costKobo)} />
        <Stat
          label="Incl. expenses / kg"
          value={allInPerKg === null ? "—" : `${money(allInPerKg)}`}
          hint={`${money(expensesKobo)} expenses`}
        />
      </dl>

      <Card>
        <CardContent className="flex flex-col gap-6">
          <TripLinks
            tripId={trip.id}
            direction={trip.direction}
            linked={linked}
            candidates={candidates}
            canWrite={canWrite}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trip expenses</CardTitle>
        </CardHeader>
        <CardContent>
          {trip.expenses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No expenses attached.{" "}
              <Link href="/expenses" className="underline underline-offset-4">
                Record one on the expenses page
              </Link>{" "}
              and attach it to this trip.
            </p>
          ) : (
            <ul className="divide-y">
              {trip.expenses.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">{e.expenseNumber}</span>{" "}
                    <span className="text-muted-foreground">
                      · {catName.get(e.categoryId) ?? "Expense"} · {isoDateLabel(e.expenseDate)}
                    </span>
                  </span>
                  <span className="tabular-nums">{money(e.amountKobo)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <TripForm
            mode="edit"
            tripId={trip.id}
            canWrite={canWrite}
            vehicles={vehicles.map((v) => ({ value: v.id, label: v.plateNumber }))}
            drivers={drivers.map((d) => ({ value: d.id, label: d.name }))}
            defaults={{
              direction: trip.direction,
              vehicleId: trip.vehicleId ?? "",
              driverId: trip.driverId ?? "",
              origin: trip.origin ?? "",
              destination: trip.destination ?? "",
              tripDate: trip.tripDate,
              costNaira: koboToNairaInput(trip.costKobo, true),
              note: trip.note ?? "",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
