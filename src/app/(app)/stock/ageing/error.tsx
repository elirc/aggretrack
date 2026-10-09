"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function AgeingError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="stock ageing" reset={reset} />;
}
