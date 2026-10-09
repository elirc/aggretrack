"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function CountsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="stock counts" reset={reset} />;
}
