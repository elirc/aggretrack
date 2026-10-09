"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function AdjustmentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this adjustment" reset={reset} />;
}
