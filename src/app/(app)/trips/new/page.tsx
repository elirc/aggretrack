import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { TripForm } from "@/components/logistics/TripForm";
import { todayLagos } from "@/components/logistics/utils";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { listDrivers, listVehicles } from "@/lib/services/masterData";

export const metadata = { title: "New trip · AggreTrack" };

export default async function NewTripPage({ searchParams }: { searchParams: Promise<{ direction?: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "trip.write") || ctx.readOnly) {
    return (
      <div>
        <PageHeader title="New trip" />
        <p className="text-sm text-muted-foreground">
          {ctx.readOnly
            ? "Subscription inactive — trips are read only."
            : "You don't have permission to record trips."}
        </p>
      </div>
    );
  }
  const { direction } = await searchParams;
  const [vehicles, drivers] = await Promise.all([listVehicles(db, ctx), listDrivers(db, ctx)]);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/trips" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> Trips
      </Link>
      <PageHeader title="New trip" description="Vehicle, driver, route and cost. Link loads after saving." />
      <Card>
        <CardContent>
          <TripForm
            mode="create"
            canWrite
            vehicles={vehicles.map((v) => ({ value: v.id, label: v.plateNumber }))}
            drivers={drivers.map((d) => ({ value: d.id, label: d.name }))}
            defaults={{
              direction: direction === "outbound" ? "outbound" : "inbound",
              vehicleId: "",
              driverId: "",
              origin: "",
              destination: "",
              tripDate: todayLagos(),
              costNaira: "",
              note: "",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
