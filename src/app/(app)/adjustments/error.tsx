"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function AdjustmentsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="adjustments" reset={reset} />;
}
