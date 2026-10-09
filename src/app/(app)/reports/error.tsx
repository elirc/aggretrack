"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function ReportsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="reports" reset={reset} />;
}
